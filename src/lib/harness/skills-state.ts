/**
 * The Skills section's state, and the reads and writes that fill it.
 *
 * Two views over the same skills: Codeg's own (the store's Custom and Harness
 * skills, switched per agent — see `skill-links.ts`), and one agent's, in one
 * scope, with every skill it sees and whose each is. Everything lives in
 * slots, so a trip to a conversation and back finds the section as it was
 * left: the view, the agent and scope, the search, the selection, the
 * offsets, and an editor still open with what was typed into it.
 *
 * What may be edited is the engine's rule, presented: a Custom skill is
 * edited in Codeg's store, an agent's own skill in place; a pack's or a
 * Harness skill is read only, and is copied into a Custom skill to be
 * changed. The backend refuses the rest whatever the page does.
 */
import {
  acpListAgentSkills,
  acpReadAgentSkill,
  acpSaveAgentSkill,
  customCreateSkill,
  customDeleteSkills,
  customDuplicateSkill,
  customImportSkill,
  customReadSkill,
  customSaveSkill,
} from "@/lib/api"
import { defineHarnessSlot, type HarnessSlotStore } from "@/lib/harness-slots"
import {
  skillPageDelete,
  skillsAdopt,
  skillsBackupDelete,
  skillsBackupRestore,
} from "@/lib/skills/api"
import { skillsFailureOf, type SkillsFailure } from "@/lib/skills/errors"
import { normalizeAgentSkills } from "@/lib/skills/normalize"
import { seenBy } from "@/lib/skills/model"
import type {
  SkillBackup,
  SkillPageDeleteResult,
  SkillsAdoptResult,
  SkillsBackupResult,
} from "@/lib/skills/types"
import type {
  AgentSkillItem,
  AgentSkillLayout,
  AgentSkillScope,
  AgentSkillsListResult,
  AgentType,
  CustomDeleteResult,
} from "@/lib/types"
import {
  currentModel,
  defineLinks,
  reloadInventory,
  requestToggle,
  type Links,
} from "./skill-links"

let lastRequest = 0
const newRequest = () => ++lastRequest
let lastDialog = 0

// ─── Views, filters, selection ────────────────────────────────────────

export type SkillsView = "managed" | "agent"

export const SKILLS_VIEW = defineHarnessSlot<SkillsView>(
  "skills",
  () => "managed"
)

/** `harness` and `updates` are offered only once there is something they
 *  could match. */
export type SkillsShow = "all" | "custom" | "harness" | "problems" | "updates"

export interface SkillsFilters {
  text: string
  show: SkillsShow
}

export const DEFAULT_SKILLS_FILTERS: SkillsFilters = { text: "", show: "all" }

export const SKILLS_FILTERS = defineHarnessSlot<SkillsFilters>(
  "skills",
  () => DEFAULT_SKILLS_FILTERS
)

/** The Codeg-managed skill open in the detail — a store id, or
 *  {@link brokenSelection} for one of Codeg's broken links. */
export const SKILLS_SELECTED = defineHarnessSlot<string | null>(
  "skills",
  () => null
)

export const BROKEN_PREFIX = "broken:"
export const brokenSelection = (path: string) => `${BROKEN_PREFIX}${path}`

/** Agents that are not installed (and see nothing of Codeg's) are folded away
 *  until this is on. */
export const SKILLS_SHOW_ALL_AGENTS = defineHarnessSlot<boolean>(
  "skills",
  () => false
)

/** The skills ticked in the grid, for a batch. */
export const SKILLS_TICKED = defineHarnessSlot<readonly string[]>(
  "skills",
  () => []
)

/** How far each view's list is scrolled. Read once, on the way back in. */
export const SKILLS_LIST_SCROLL = defineHarnessSlot<
  Readonly<Record<SkillsView, number>>
>("skills", () => ({ managed: 0, agent: 0 }))

/** How far the open detail is scrolled — for that detail only. */
export const SKILLS_DETAIL_SCROLL = defineHarnessSlot<{
  id: string
  top: number
} | null>("skills", () => null)

/** The row a closed detail was opened from, which gets the focus back. */
export const SKILLS_RETURN_FOCUS = defineHarnessSlot<string | null>(
  "skills",
  () => null
)

/** A skill asked for (`openHarness`) before the inventory said where it is. */
export const SKILLS_PENDING_TARGET = defineHarnessSlot<string | null>(
  "skills",
  () => null
)

/** "Keep it", per changed copy (by cell, with the copy's path): the question
 *  is not asked again for that copy. */
export const SKILLS_COPIES_KEPT = defineHarnessSlot<
  Readonly<Record<string, string>>
>("skills", () => ({}))

// ─── One agent's skills ───────────────────────────────────────────────

export interface AgentScope {
  agent: AgentType | null
  scope: AgentSkillScope
  /** The project folder; `null` until one is chosen (or none is open). */
  folder: string | null
}

export const SKILLS_AGENT_SCOPE = defineHarnessSlot<AgentScope>(
  "skills",
  () => ({ agent: null, scope: "global", folder: null })
)

export interface AgentListState {
  phase: "idle" | "loading" | "ready" | "error"
  /** What the list was read for — `agentListKey` of the scope. */
  key: string | null
  result: AgentSkillsListResult | null
  error: SkillsFailure | null
  request: number
}

export const SKILLS_AGENT_LIST = defineHarnessSlot<AgentListState>(
  "skills",
  () => ({ phase: "idle", key: null, result: null, error: null, request: 0 })
)

export const SKILLS_AGENT_FILTER = defineHarnessSlot<string>("skills", () => "")

/** The agent's skill open in the detail, by id. */
export const SKILLS_AGENT_SELECTED = defineHarnessSlot<string | null>(
  "skills",
  () => null
)

export function agentListKey(scope: AgentScope): string | null {
  if (!scope.agent) return null
  if (scope.scope === "project" && !scope.folder) return null
  return `${scope.agent}|${scope.scope}|${scope.scope === "project" ? scope.folder : ""}`
}

/** The listed skills of the scope on show, in the order the agent reads
 *  them. */
export function skillsInScope(
  state: AgentListState,
  scope: AgentScope
): AgentSkillItem[] {
  if (!state.result || state.key !== agentListKey(scope)) return []
  return state.result.skills.filter((item) => item.scope === scope.scope)
}

/** Read the agent's skills for the scope on show again. */
export async function reloadAgentList(slots: HarnessSlotStore): Promise<void> {
  const scope = slots.get(SKILLS_AGENT_SCOPE)
  const key = agentListKey(scope)
  if (!key || !scope.agent) {
    slots.set(
      SKILLS_AGENT_LIST,
      (prev): AgentListState => ({
        ...prev,
        phase: "idle",
        key: null,
        error: null,
      })
    )
    return
  }
  const request = newRequest()
  slots.set(
    SKILLS_AGENT_LIST,
    (prev): AgentListState => ({
      ...prev,
      phase: "loading",
      key,
      // Another scope's list is not shown while this one is read.
      result: prev.key === key ? prev.result : null,
      error: null,
      request,
    })
  )
  const current = () => slots.get(SKILLS_AGENT_LIST).request === request
  try {
    const result = normalizeAgentSkills(
      await acpListAgentSkills({
        agentType: scope.agent,
        workspacePath: scope.scope === "project" ? scope.folder : null,
        includeBroken: true,
      })
    )
    if (!current()) return
    slots.set(
      SKILLS_AGENT_LIST,
      (prev): AgentListState => ({
        ...prev,
        phase: "ready",
        result,
        error: null,
      })
    )
  } catch (error) {
    if (!current()) return
    slots.set(
      SKILLS_AGENT_LIST,
      (prev): AgentListState => ({
        ...prev,
        phase: "error",
        error: skillsFailureOf(error),
      })
    )
  }
}

export function setAgentScope(
  slots: HarnessSlotStore,
  update: Partial<AgentScope>
): void {
  const prev = slots.get(SKILLS_AGENT_SCOPE)
  const next = { ...prev, ...update }
  if (
    next.agent === prev.agent &&
    next.scope === prev.scope &&
    next.folder === prev.folder
  ) {
    return
  }
  slots.set(SKILLS_AGENT_SCOPE, next)
  slots.set(SKILLS_AGENT_SELECTED, null)
  void reloadAgentList(slots)
}

// ─── Reading ──────────────────────────────────────────────────────────

/** After every inventory read: a target that waited for it goes where it
 *  belongs, and an open editor finds out whether its skill changed. */
function afterRead(slots: HarnessSlotStore) {
  const pending = slots.get(SKILLS_PENDING_TARGET)
  if (pending !== null) openSkillTarget(slots, pending)
  void checkEditorDrift(slots)
}

export const SKILLS_LINKS: Links = defineLinks("skills", afterRead)

/** Read everything the section shows again — once per visit, once per
 *  `skills://changed`, and after each of its own writes. */
export function reloadSkills(slots: HarnessSlotStore): Promise<void> {
  const inventory = reloadInventory(slots, SKILLS_LINKS)
  const list =
    slots.get(SKILLS_VIEW) === "agent" ? reloadAgentList(slots) : undefined
  return Promise.all([inventory.done, list]).then(() => undefined)
}

// ─── Opening a skill ──────────────────────────────────────────────────

/**
 * Open one skill — what `openHarness({ section: "skills", skillId })` asks
 * for — in whichever view holds it: Codeg-managed for a Custom or Harness
 * skill; for a pack's skill, the view of the first agent that sees it (it is
 * listed there, and its pack's own place is the Skill-packs section). Before
 * the inventory is read the request waits for it, on the managed view.
 */
export function openSkillTarget(slots: HarnessSlotStore, id: string): void {
  const model = currentModel(slots, SKILLS_LINKS)
  if (!model) {
    slots.set(SKILLS_VIEW, "managed")
    slots.set(SKILLS_FILTERS, DEFAULT_SKILLS_FILTERS)
    slots.set(SKILLS_SELECTED, id)
    slots.set(SKILLS_PENDING_TARGET, id)
    return
  }
  slots.set(SKILLS_PENDING_TARGET, null)
  const skill = model.skill(id)
  if (skill && skill.origin !== "custom" && skill.origin !== "harness") {
    const agent = seenBy(skill)[0]
    if (agent) {
      slots.set(SKILLS_VIEW, "agent")
      slots.set(SKILLS_AGENT_FILTER, "")
      setAgentScope(slots, { agent, scope: "global" })
      slots.set(SKILLS_AGENT_SELECTED, id)
      return
    }
  }
  slots.set(SKILLS_VIEW, "managed")
  slots.set(SKILLS_FILTERS, DEFAULT_SKILLS_FILTERS)
  slots.set(SKILLS_SELECTED, id)
}

/** Back from a detail, on a pane that shows one screen at a time. */
export function closeSkillsDetail(slots: HarnessSlotStore): void {
  const view = slots.get(SKILLS_VIEW)
  const slot = view === "managed" ? SKILLS_SELECTED : SKILLS_AGENT_SELECTED
  const selected = slots.get(slot)
  if (selected === null) return
  slots.set(SKILLS_RETURN_FOCUS, selected)
  slots.set(slot, null)
}

// ─── Dialogs ──────────────────────────────────────────────────────────

/** Whose SKILL.md an editor writes, and how. */
export type EditorTarget =
  | {
      kind: "custom"
      mode: "create" | "edit"
      skillId: string
      /** A new skill for an agent with no skills folder of its own: made a
       *  Custom skill, then turned on for this agent — through the plan that
       *  shows who else would see it. */
      enableFor?: AgentType
    }
  | {
      kind: "agent"
      mode: "create" | "edit"
      agent: AgentType
      scope: AgentSkillScope
      workspacePath: string | null
      skillId: string
      layout: AgentSkillLayout | null
      /** Where it is (edit), or the folder a new one goes in (create). */
      path: string | null
    }

/**
 * The one SKILL.md editor, for every skill the page lets the user write.
 * `base` is the file as it was read (or the template a new one starts
 * from): what "unsaved" is measured against, and what a save checks the
 * file still holds.
 */
export interface SkillEditorDialog {
  kind: "editor"
  id: number
  target: EditorTarget
  /** The id being typed, for a new skill. */
  draftId: string
  content: string
  base: string
  view: "edit" | "preview"
  phase: "loading" | "ready" | "saving"
  loadFailure: SkillsFailure | null
  saveFailure: SkillsFailure | null
  /** The file as it is now, when it no longer holds `base`: changed
   *  elsewhere while the editor was open. */
  drift: string | null
  request: number
}

/**
 * Delete — a Custom skill everywhere, or one entry of an agent's. An agent's
 * entry is asked about first (`checking`): what goes, and which other agents
 * read that folder and lose it too. The delete itself carries that answer's
 * `ack`; if the folder changed in between, it is asked about again and shown
 * again, and nothing is deleted.
 */
export interface SkillDeleteDialog {
  kind: "delete"
  id: number
  target:
    | { kind: "custom"; ids: string[] }
    | {
        kind: "agent"
        agent: AgentType
        scope: AgentSkillScope
        workspacePath: string | null
        item: AgentSkillItem
      }
  phase: "checking" | "confirm" | "saving" | "result"
  results: CustomDeleteResult[] | null
  failure: SkillsFailure | null
  /** An agent's entry: what deleting it does, as last asked. */
  plan: SkillPageDeleteResult | null
  /** The plan was made again because the one shown no longer held. */
  notice: "changed" | null
  /** An agent's entry: what the delete answered. */
  done: SkillPageDeleteResult | null
  request: number
}

/** Move an agent's own skill into Codeg management. */
export interface SkillAdoptDialog {
  kind: "adopt"
  id: number
  agent: AgentType
  skillId: string
  /** The directory it is in. */
  dir: string | null
  phase: "confirm" | "saving" | "result"
  result: SkillsAdoptResult | null
  failure: SkillsFailure | null
}

/** Copy a store skill into a new Custom skill. */
export interface SkillCopyDialog {
  kind: "copy"
  id: number
  sourceId: string
  newId: string
  phase: "input" | "saving"
  failure: SkillsFailure | null
}

/** Restore a backup as a new Custom skill. */
export interface BackupRestoreDialog {
  kind: "restore"
  id: number
  backup: SkillBackup
  newId: string
  phase: "input" | "saving" | "result"
  result: SkillsBackupResult | null
  failure: SkillsFailure | null
}

/** Delete a backup. */
export interface BackupDeleteDialog {
  kind: "backupDelete"
  id: number
  backup: SkillBackup
  phase: "confirm" | "saving" | "result"
  result: SkillsBackupResult | null
  failure: SkillsFailure | null
}

export type SkillsDialog =
  | SkillEditorDialog
  | SkillDeleteDialog
  | SkillAdoptDialog
  | SkillCopyDialog
  | BackupRestoreDialog
  | BackupDeleteDialog

export const SKILLS_DIALOG = defineHarnessSlot<SkillsDialog | null>(
  "skills",
  () => null
)

type DialogOf<K extends SkillsDialog["kind"]> = Extract<
  SkillsDialog,
  { kind: K }
>

/** Change the open dialog — only if it is still the one `id` names. */
export function updateSkillsDialog<K extends SkillsDialog["kind"]>(
  slots: HarnessSlotStore,
  id: number,
  kind: K,
  update: (dialog: DialogOf<K>) => DialogOf<K>
): void {
  slots.set(SKILLS_DIALOG, (prev) =>
    prev && prev.id === id && prev.kind === kind
      ? update(prev as DialogOf<K>)
      : prev
  )
}

export function closeSkillsDialog(slots: HarnessSlotStore, id: number): void {
  slots.set(SKILLS_DIALOG, (prev) => (prev && prev.id === id ? null : prev))
}

function dialogOf<K extends SkillsDialog["kind"]>(
  slots: HarnessSlotStore,
  id: number,
  kind: K
): DialogOf<K> | null {
  const dialog = slots.get(SKILLS_DIALOG)
  return dialog && dialog.id === id && dialog.kind === kind
    ? (dialog as DialogOf<K>)
    : null
}

// ─── The editor ───────────────────────────────────────────────────────

function readTarget(target: EditorTarget): Promise<string> {
  if (target.kind === "custom") return customReadSkill(target.skillId)
  return acpReadAgentSkill({
    agentType: target.agent,
    scope: target.scope,
    skillId: target.skillId,
    workspacePath: target.scope === "project" ? target.workspacePath : null,
  }).then((detail) => detail.content)
}

/**
 * Open the editor. A new skill starts from `template`; an existing one is
 * read first.
 */
export function openEditor(
  slots: HarnessSlotStore,
  target: EditorTarget,
  template = ""
): void {
  const id = ++lastDialog
  const request = newRequest()
  const create = target.mode === "create"
  slots.set(SKILLS_DIALOG, {
    kind: "editor",
    id,
    target,
    draftId: create ? target.skillId : "",
    content: create ? template : "",
    base: create ? template : "",
    view: "edit",
    phase: create ? "ready" : "loading",
    loadFailure: null,
    saveFailure: null,
    drift: null,
    request,
  })
  if (create) return
  readTarget(target).then(
    (content) =>
      updateSkillsDialog(slots, id, "editor", (prev) =>
        prev.request !== request
          ? prev
          : { ...prev, content, base: content, phase: "ready" }
      ),
    (error: unknown) =>
      updateSkillsDialog(slots, id, "editor", (prev) =>
        prev.request !== request
          ? prev
          : { ...prev, phase: "ready", loadFailure: skillsFailureOf(error) }
      )
  )
}

export function editorIsDirty(dialog: SkillEditorDialog): boolean {
  if (dialog.target.mode === "create") {
    return dialog.content !== dialog.base || dialog.draftId.trim() !== ""
  }
  return dialog.phase !== "loading" && dialog.content !== dialog.base
}

/** Whether an existing skill's file still holds what the editor read. Sets
 *  `drift` when it does not. A file that cannot be read is left for the
 *  save to report. */
async function checkDrift(
  slots: HarnessSlotStore,
  id: number
): Promise<boolean> {
  const dialog = dialogOf(slots, id, "editor")
  if (!dialog || dialog.target.mode !== "edit" || dialog.loadFailure) {
    return false
  }
  let now: string
  try {
    now = await readTarget(dialog.target)
  } catch {
    return false
  }
  let drifted = false
  updateSkillsDialog(slots, id, "editor", (prev) => {
    if (now === prev.base)
      return prev.drift === null ? prev : { ...prev, drift: null }
    drifted = true
    return { ...prev, drift: now }
  })
  return drifted
}

/** After a refresh: an open editor finds out whether its skill changed —
 *  and says so, never loads it over what is being typed. */
export async function checkEditorDrift(slots: HarnessSlotStore) {
  const dialog = slots.get(SKILLS_DIALOG)
  if (dialog?.kind !== "editor" || dialog.phase !== "ready") return
  await checkDrift(slots, dialog.id)
}

/** Take the version on disk, dropping what was typed. */
export function takeDrift(slots: HarnessSlotStore, id: number): void {
  updateSkillsDialog(slots, id, "editor", (prev) =>
    prev.drift === null
      ? prev
      : { ...prev, content: prev.drift, base: prev.drift, drift: null }
  )
}

/** Keep what was typed: the version on disk becomes what the save will be
 *  written over — which the user has just been told. */
export function keepMine(slots: HarnessSlotStore, id: number): void {
  updateSkillsDialog(slots, id, "editor", (prev) =>
    prev.drift === null ? prev : { ...prev, base: prev.drift, drift: null }
  )
}

/**
 * Save the editor. An existing skill is read once more first: if it changed
 * since the editor read it, nothing is written and the editor says so. A new
 * skill is created with `create`, so a name that is taken anywhere it could
 * be is refused, not written over.
 */
export async function saveEditor(
  slots: HarnessSlotStore,
  id: number
): Promise<void> {
  const dialog = dialogOf(slots, id, "editor")
  if (!dialog || dialog.phase !== "ready" || dialog.drift !== null) return
  if (await checkDrift(slots, id)) return
  const current = dialogOf(slots, id, "editor")
  if (!current) return
  const target = current.target
  const skillId =
    target.mode === "create" ? current.draftId.trim() : target.skillId
  updateSkillsDialog(slots, id, "editor", (prev) => ({
    ...prev,
    phase: "saving",
    saveFailure: null,
  }))
  try {
    if (target.kind === "custom") {
      if (target.mode === "create") {
        await customCreateSkill({ id: skillId, content: current.content })
      } else {
        await customSaveSkill({ id: skillId, content: current.content })
      }
    } else {
      await acpSaveAgentSkill({
        agentType: target.agent,
        scope: target.scope,
        skillId,
        content: current.content,
        workspacePath: target.scope === "project" ? target.workspacePath : null,
        layout: target.layout,
        create: target.mode === "create",
      })
    }
  } catch (error) {
    updateSkillsDialog(slots, id, "editor", (prev) => ({
      ...prev,
      phase: "ready",
      saveFailure: skillsFailureOf(error),
    }))
    return
  }
  closeSkillsDialog(slots, id)
  if (target.kind === "custom") {
    slots.set(SKILLS_VIEW, "managed")
    slots.set(SKILLS_SELECTED, skillId)
  } else {
    slots.set(SKILLS_AGENT_SELECTED, skillId)
  }
  await reloadSkills(slots)
  if (
    target.kind === "custom" &&
    target.mode === "create" &&
    target.enableFor
  ) {
    // As any switch is: planned, and shown when others would see it too.
    requestToggle(slots, SKILLS_LINKS, skillId, target.enableFor)
  }
}

/**
 * A new skill the backend would not put in the agent's folders — the agent
 * has none of its own, and others read the one it has (`no_own_directory`):
 * the same name and text become a new Custom skill, to be turned on for the
 * agent once it is saved.
 */
export function makeCustomInstead(slots: HarnessSlotStore, id: number): void {
  updateSkillsDialog(slots, id, "editor", (prev) => {
    const target = prev.target
    if (target.kind !== "agent" || target.mode !== "create") return prev
    return {
      ...prev,
      target: {
        kind: "custom",
        mode: "create",
        skillId: prev.draftId,
        enableFor: target.agent,
      },
      saveFailure: null,
    }
  })
}

// ─── Copy as a Custom skill ───────────────────────────────────────────

export function openCopyDialog(
  slots: HarnessSlotStore,
  sourceId: string,
  newId: string
): void {
  slots.set(SKILLS_DIALOG, {
    kind: "copy",
    id: ++lastDialog,
    sourceId,
    newId,
    phase: "input",
    failure: null,
  })
}

/**
 * Copy the whole skill folder into a new Custom skill, then open it in the
 * editor: copying is how a read-only skill gets changed. The copy is on for
 * no agent until the user turns it on.
 */
export async function runCopy(
  slots: HarnessSlotStore,
  id: number
): Promise<void> {
  const dialog = dialogOf(slots, id, "copy")
  if (!dialog || dialog.phase !== "input") return
  const newId = dialog.newId.trim()
  updateSkillsDialog(slots, id, "copy", (prev) => ({
    ...prev,
    phase: "saving",
    failure: null,
  }))
  try {
    await customDuplicateSkill({ sourceId: dialog.sourceId, newId })
  } catch (error) {
    updateSkillsDialog(slots, id, "copy", (prev) => ({
      ...prev,
      phase: "input",
      failure: skillsFailureOf(error),
    }))
    return
  }
  closeSkillsDialog(slots, id)
  slots.set(SKILLS_VIEW, "managed")
  slots.set(SKILLS_FILTERS, DEFAULT_SKILLS_FILTERS)
  slots.set(SKILLS_SELECTED, newId)
  openEditor(slots, { kind: "custom", mode: "edit", skillId: newId })
  await reloadSkills(slots)
}

// ─── Delete ───────────────────────────────────────────────────────────

export function openDeleteDialog(
  slots: HarnessSlotStore,
  target: SkillDeleteDialog["target"]
): void {
  const id = ++lastDialog
  slots.set(SKILLS_DIALOG, {
    kind: "delete",
    id,
    target,
    phase: target.kind === "agent" ? "checking" : "confirm",
    results: null,
    failure: null,
    plan: null,
    notice: null,
    done: null,
    request: newRequest(),
  })
  if (target.kind === "agent") void planAgentDelete(slots, id, null)
}

const deleteArgs = (
  target: Extract<SkillDeleteDialog["target"], { kind: "agent" }>
) => ({
  agent: target.agent,
  scope: target.scope,
  skillId: target.item.id,
  workspacePath: target.scope === "project" ? target.workspacePath : null,
})

/** Ask what deleting an agent's entry does — deleting nothing. */
export async function planAgentDelete(
  slots: HarnessSlotStore,
  id: number,
  notice: SkillDeleteDialog["notice"]
): Promise<void> {
  const dialog = dialogOf(slots, id, "delete")
  if (!dialog || dialog.target.kind !== "agent") return
  const request = newRequest()
  updateSkillsDialog(slots, id, "delete", (prev) => ({
    ...prev,
    phase: "checking",
    failure: null,
    plan: null,
    notice,
    request,
  }))
  let plan: SkillPageDeleteResult | null = null
  let failure: SkillsFailure | null = null
  try {
    plan = await skillPageDelete({
      ...deleteArgs(dialog.target),
      preflight: true,
    })
  } catch (error) {
    failure = skillsFailureOf(error)
  }
  updateSkillsDialog(slots, id, "delete", (prev) =>
    prev.request !== request
      ? prev
      : { ...prev, phase: "confirm", plan, failure }
  )
}

export async function runDelete(
  slots: HarnessSlotStore,
  id: number
): Promise<void> {
  const dialog = dialogOf(slots, id, "delete")
  if (!dialog || dialog.phase !== "confirm") return
  if (dialog.target.kind === "agent" && !dialog.plan) return
  updateSkillsDialog(slots, id, "delete", (prev) => ({
    ...prev,
    phase: "saving",
    failure: null,
  }))
  const target = dialog.target
  if (target.kind === "custom") {
    let results: CustomDeleteResult[] | null = null
    let failure: SkillsFailure | null = null
    try {
      results = await customDeleteSkills(target.ids)
    } catch (error) {
      failure = skillsFailureOf(error)
    }
    const deleted = new Set(
      (results ?? []).filter((r) => r.ok).map((r) => r.id)
    )
    if (deleted.size > 0) {
      slots.set(SKILLS_TICKED, (prev) => prev.filter((t) => !deleted.has(t)))
      const selected = slots.get(SKILLS_SELECTED)
      if (selected && deleted.has(selected)) slots.set(SKILLS_SELECTED, null)
    }
    if (results && failure === null && results.every((r) => r.ok)) {
      closeSkillsDialog(slots, id)
    } else {
      updateSkillsDialog(slots, id, "delete", (prev) => ({
        ...prev,
        phase: "result",
        results,
        failure,
      }))
    }
    await reloadSkills(slots)
    return
  }
  // Only what was shown is deleted: the ack of the plan on screen, or none.
  const plan = dialog.plan
  if (!plan) return
  let done: SkillPageDeleteResult
  try {
    done = await skillPageDelete({
      ...deleteArgs(target),
      preflight: false,
      ack: plan.ack,
    })
  } catch (error) {
    const failure = skillsFailureOf(error)
    if (
      failure.kind === "coded" &&
      (failure.code === "acknowledgement_required" ||
        failure.code === "effects_changed")
    ) {
      // Who reads that folder changed since it was shown: nothing was
      // deleted. Show what it would do now, and ask again.
      await planAgentDelete(slots, id, "changed")
      return
    }
    updateSkillsDialog(slots, id, "delete", (prev) => ({
      ...prev,
      phase: "result",
      failure,
    }))
    await reloadSkills(slots)
    return
  }
  if (done.deleted) {
    closeSkillsDialog(slots, id)
  } else {
    updateSkillsDialog(slots, id, "delete", (prev) => ({
      ...prev,
      phase: "result",
      done,
    }))
  }
  if (slots.get(SKILLS_AGENT_SELECTED) === target.item.id) {
    slots.set(SKILLS_AGENT_SELECTED, null)
  }
  await reloadSkills(slots)
}

// ─── Move into Codeg management ───────────────────────────────────────

export function openAdoptDialog(
  slots: HarnessSlotStore,
  agent: AgentType,
  skillId: string,
  dir: string | null
): void {
  slots.set(SKILLS_DIALOG, {
    kind: "adopt",
    id: ++lastDialog,
    agent,
    skillId,
    dir,
    phase: "confirm",
    result: null,
    failure: null,
  })
}

export async function runAdopt(
  slots: HarnessSlotStore,
  id: number
): Promise<void> {
  const dialog = dialogOf(slots, id, "adopt")
  if (!dialog || dialog.phase !== "confirm") return
  updateSkillsDialog(slots, id, "adopt", (prev) => ({
    ...prev,
    phase: "saving",
    failure: null,
  }))
  let result: SkillsAdoptResult | null = null
  let failure: SkillsFailure | null = null
  try {
    result = await skillsAdopt({
      agent: dialog.agent,
      skill: dialog.skillId,
      dir: dialog.dir,
    })
  } catch (error) {
    failure = skillsFailureOf(error)
  }
  updateSkillsDialog(slots, id, "adopt", (prev) => ({
    ...prev,
    phase: "result",
    result,
    failure,
  }))
  await reloadSkills(slots)
}

// ─── Backups ──────────────────────────────────────────────────────────

export function openRestoreDialog(
  slots: HarnessSlotStore,
  backup: SkillBackup,
  newId: string
): void {
  slots.set(SKILLS_DIALOG, {
    kind: "restore",
    id: ++lastDialog,
    backup,
    newId,
    phase: "input",
    result: null,
    failure: null,
  })
}

export async function runRestore(
  slots: HarnessSlotStore,
  id: number
): Promise<void> {
  const dialog = dialogOf(slots, id, "restore")
  if (!dialog || dialog.phase !== "input") return
  const newId = dialog.newId.trim()
  updateSkillsDialog(slots, id, "restore", (prev) => ({
    ...prev,
    phase: "saving",
    failure: null,
  }))
  let result: SkillsBackupResult | null = null
  let failure: SkillsFailure | null = null
  try {
    result = await skillsBackupRestore({
      skill: dialog.backup.skill,
      name: dialog.backup.name,
      id: newId,
    })
  } catch (error) {
    failure = skillsFailureOf(error)
  }
  if (result?.ok && result.outcome === "restored") {
    slots.set(SKILLS_VIEW, "managed")
    slots.set(SKILLS_FILTERS, DEFAULT_SKILLS_FILTERS)
    slots.set(SKILLS_SELECTED, result.id ?? newId)
  }
  updateSkillsDialog(slots, id, "restore", (prev) => ({
    ...prev,
    // A refusal is told beside the name, which can be changed and tried
    // again; what was done is told as a result.
    phase:
      result && !result.ok && result.outcome === "invalid" ? "input" : "result",
    result,
    failure,
  }))
  await reloadSkills(slots)
}

export function openBackupDeleteDialog(
  slots: HarnessSlotStore,
  backup: SkillBackup
): void {
  slots.set(SKILLS_DIALOG, {
    kind: "backupDelete",
    id: ++lastDialog,
    backup,
    phase: "confirm",
    result: null,
    failure: null,
  })
}

export async function runBackupDelete(
  slots: HarnessSlotStore,
  id: number
): Promise<void> {
  const dialog = dialogOf(slots, id, "backupDelete")
  if (!dialog || dialog.phase !== "confirm") return
  updateSkillsDialog(slots, id, "backupDelete", (prev) => ({
    ...prev,
    phase: "saving",
    failure: null,
  }))
  let result: SkillsBackupResult | null = null
  let failure: SkillsFailure | null = null
  try {
    result = await skillsBackupDelete({
      skill: dialog.backup.skill,
      name: dialog.backup.name,
    })
  } catch (error) {
    failure = skillsFailureOf(error)
  }
  if (result?.ok && result.outcome === "deleted") {
    closeSkillsDialog(slots, id)
  } else {
    updateSkillsDialog(slots, id, "backupDelete", (prev) => ({
      ...prev,
      phase: "result",
      result,
      failure,
    }))
  }
  await reloadSkills(slots)
}

// ─── Import ───────────────────────────────────────────────────────────

export interface ImportState {
  phase: "idle" | "saving" | "failed"
  failure: SkillsFailure | null
}

export const SKILLS_IMPORT = defineHarnessSlot<ImportState>("skills", () => ({
  phase: "idle",
  failure: null,
}))

/** Import a folder with a SKILL.md (or a single `.md`) as a Custom skill. */
export async function runImport(
  slots: HarnessSlotStore,
  sourcePath: string
): Promise<void> {
  if (slots.get(SKILLS_IMPORT).phase === "saving") return
  slots.set(SKILLS_IMPORT, { phase: "saving", failure: null })
  try {
    const item = await customImportSkill({ sourcePath })
    slots.set(SKILLS_IMPORT, { phase: "idle", failure: null })
    slots.set(SKILLS_VIEW, "managed")
    slots.set(SKILLS_FILTERS, DEFAULT_SKILLS_FILTERS)
    slots.set(SKILLS_SELECTED, item.id)
  } catch (error) {
    slots.set(SKILLS_IMPORT, {
      phase: "failed",
      failure: skillsFailureOf(error),
    })
  }
  await reloadSkills(slots)
}
