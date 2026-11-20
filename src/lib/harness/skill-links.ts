/**
 * Switching Codeg's skills on and off for agents — the part the Skills and the
 * Skill-packs sections share: reading the inventory, each cell's own save, and
 * the confirmation an op needs when its effects reach other agents.
 *
 * All of it lives in slots (`harness-slots.ts`), so a save started just before
 * the page is left still has somewhere to land, and a question left open is
 * still open on the way back. Each section has its own set ({@link
 * defineLinks}); the functions here take the set they act on.
 *
 * Three rules hold throughout:
 *
 * - **The inventory is only ever read, never patched.** Every change — a save
 *   here, `skills://changed` from anywhere — is followed by a fresh
 *   `skills_inventory`, and only the answer to the latest request is kept.
 * - **Nothing reaches another agent unseen.** An op that may (a shared
 *   directory, "only for", a copy to replace) is planned first; when the plan
 *   says it reaches other agents, it is shown, and carried out only with the
 *   `ack` of the plan that was shown. If the effects changed in between, the
 *   engine writes nothing and the page plans again and asks again.
 * - **Nothing locks the page.** A skill being written is busy until the
 *   inventory read after the write has landed; only its own switches wait.
 */
import {
  defineHarnessSlot,
  type HarnessSlot,
  type HarnessSlotStore,
} from "@/lib/harness-slots"
import type { HarnessSectionId } from "@/lib/harness-sections"
import {
  skillsApplyLinks,
  skillsBackups,
  skillsInventory,
  skillsRepairLink,
} from "@/lib/skills/api"
import { skillsFailureOf, type SkillsFailure } from "@/lib/skills/errors"
import { buildModel, cellView, type SkillsModel } from "@/lib/skills/model"
import {
  deltaOps,
  isApplied,
  mustReview,
  opsWithAcks,
  skillsOf,
  type CellTarget,
} from "@/lib/skills/ops"
import type {
  RepairAction,
  SkillBackup,
  SkillOp,
  SkillsApplyResult,
  SkillsInventory,
  SkillsIssue,
  SkillsRepairResult,
} from "@/lib/skills/types"
import type { AgentType } from "@/lib/types"

// One counter for every read and write, kept outside the slots: a reset
// section must not hand out a number an answer from before the reset still
// carries.
let lastRequest = 0
const newRequest = () => ++lastRequest

// ─── The slots ────────────────────────────────────────────────────────

export interface SkillsInventoryState {
  phase: "idle" | "loading" | "ready" | "error"
  /** The last inventory read — kept while a new one is read, and when that
   *  fails, so the page never goes blank over a refresh. */
  inventory: SkillsInventory | null
  /** Every backup, by the skill it is a backup of; `null` until read (or
   *  when it could not be). */
  backups: Readonly<Record<string, SkillBackup[]>> | null
  backupProblems: SkillsIssue[]
  error: SkillsFailure | null
  /** The read these contents belong to, or are waiting for. */
  request: number
}

/** What one switch is doing, by {@link cellKey}. */
export interface CellWrite {
  seq: number
  skill: string
  agent: AgentType
  /** Where the switch is going. */
  on: boolean
  /** `checking`: being planned; `saved` lasts until the inventory read after
   *  it has landed. */
  phase: "checking" | "saving" | "saved" | "failed"
  ops: SkillOp[]
  result: SkillsApplyResult | null
  failure: SkillsFailure | null
}

export interface SkillBusy {
  /** Writes in flight, per skill. */
  writing: Readonly<Record<string, number>>
  /** Per skill written: the inventory read begun after its last write. */
  awaiting: Readonly<Record<string, number>>
}

/** What the confirmation is about — its title and its wording. */
export type EffectsIntent =
  | { kind: "toggle"; skill: string; agent: AgentType; on: boolean }
  | { kind: "only"; skill: string; agent: AgentType }
  | { kind: "refresh"; skill: string; agent: AgentType; replace: boolean }
  | { kind: "repair"; skill: string; path: string; action: RepairAction }
  | { kind: "batch"; on: boolean }
  | { kind: "backupLinks"; skill: string }

/**
 * The confirmation: what the user asked for, the plan the engine made of it
 * (`plan`, a preflight — nothing written), and, once confirmed, what came of
 * it. A repair is a single op on a path; its answer is read as a one-op plan.
 */
export interface EffectsDialog {
  id: number
  intent: EffectsIntent
  /** `apply`: the ops, as asked (without acks). */
  ops: SkillOp[]
  /** `repair`: the link and what to do with it. */
  repair: { path: string; action: RepairAction } | null
  step: "checking" | "review" | "saving" | "result"
  plan: SkillsApplyResult | null
  result: SkillsApplyResult | null
  failure: SkillsFailure | null
  /** Shown again because what it would do changed since it was shown. */
  notice: "effectsChanged" | null
  /** Not shown while it is planned: carried out at once if the plan reaches
   *  no one else and stops at nothing, shown otherwise. */
  quiet: boolean
  request: number
}

/** What a screen reader is told after a switch has saved, or has not. */
export interface LinksAnnouncement {
  seq: number
  skill: string
  agent: AgentType | null
  on: boolean
  saved: boolean
}

export interface ContentState {
  phase: "loading" | "ready" | "error"
  content: string | null
  failure: SkillsFailure | null
  request: number
}

export interface Links {
  section: HarnessSectionId
  inventory: HarnessSlot<SkillsInventoryState>
  writes: HarnessSlot<Readonly<Record<string, CellWrite>>>
  busy: HarnessSlot<SkillBusy>
  effects: HarnessSlot<EffectsDialog | null>
  announcement: HarnessSlot<LinksAnnouncement | null>
  /** SKILL.md contents read for a preview, by the caller's key. */
  content: HarnessSlot<Readonly<Record<string, ContentState>>>
  /** Called after every inventory read lands — what a section adds to it. */
  afterRead?: (slots: HarnessSlotStore) => void
}

export function defineLinks(
  section: HarnessSectionId,
  afterRead?: (slots: HarnessSlotStore) => void
): Links {
  return {
    section,
    inventory: defineHarnessSlot<SkillsInventoryState>(section, () => ({
      phase: "idle",
      inventory: null,
      backups: null,
      backupProblems: [],
      error: null,
      request: 0,
    })),
    writes: defineHarnessSlot<Readonly<Record<string, CellWrite>>>(
      section,
      () => ({})
    ),
    busy: defineHarnessSlot<SkillBusy>(section, () => ({
      writing: {},
      awaiting: {},
    })),
    effects: defineHarnessSlot<EffectsDialog | null>(section, () => null),
    announcement: defineHarnessSlot<LinksAnnouncement | null>(
      section,
      () => null
    ),
    content: defineHarnessSlot<Readonly<Record<string, ContentState>>>(
      section,
      () => ({})
    ),
    afterRead,
  }
}

export const cellKey = (skill: string, agent: string) =>
  `${skill}\u0000${agent}`

// Built once per inventory: every list, detail and dialog reads the same one.
const models = new WeakMap<SkillsInventory, SkillsModel>()

export function modelOf(inventory: SkillsInventory): SkillsModel {
  let model = models.get(inventory)
  if (!model) {
    model = buildModel(inventory)
    models.set(inventory, model)
  }
  return model
}

export function currentModel(
  slots: HarnessSlotStore,
  links: Links
): SkillsModel | null {
  const { inventory } = slots.get(links.inventory)
  return inventory ? modelOf(inventory) : null
}

// ─── Reading ──────────────────────────────────────────────────────────

/**
 * Read the inventory again — with every backup, which the details list under
 * their skills. Returns the request's number at once (what a write waits
 * for) and a promise of its landing. A read a newer one overtakes lands
 * nowhere.
 */
export function reloadInventory(
  slots: HarnessSlotStore,
  links: Links
): { request: number; done: Promise<void> } {
  const request = newRequest()
  slots.set(
    links.inventory,
    (prev): SkillsInventoryState => ({ ...prev, phase: "loading", request })
  )
  const current = () => slots.get(links.inventory).request === request
  const done = (async () => {
    // Backups are a detail's extra: a backend that cannot list them still
    // gets its skills shown.
    const backups = skillsBackups().catch(() => null)
    try {
      const inventory = await skillsInventory()
      const listed = await backups
      if (!current()) return
      const bySkill: Record<string, SkillBackup[]> = {}
      for (const backup of listed?.backups ?? []) {
        ;(bySkill[backup.skill] ??= []).push(backup)
      }
      slots.set(
        links.inventory,
        (prev): SkillsInventoryState => ({
          ...prev,
          phase: "ready",
          inventory,
          backups: listed ? bySkill : null,
          backupProblems: listed?.problems ?? [],
          error: null,
        })
      )
    } catch (error) {
      if (!current()) return
      slots.set(
        links.inventory,
        (prev): SkillsInventoryState => ({
          ...prev,
          phase: "error",
          error: skillsFailureOf(error),
        })
      )
    }
    settleWrites(slots, links, request)
    // Contents read for a preview may be out of date too: they are read again
    // the next time one is shown, and kept on screen meanwhile.
    slots.set(links.content, (prev): Readonly<Record<string, ContentState>> => {
      const keys = Object.keys(prev)
      if (keys.length === 0) return prev
      const next: Record<string, ContentState> = {}
      for (const key of keys) next[key] = { ...prev[key], request: 0 }
      return next
    })
    links.afterRead?.(slots)
  })()
  return { request, done }
}

/**
 * The SKILL.md behind `key`, read once and kept — until the inventory is read
 * again, after which the next call reads it afresh (the old text stays up
 * while it does).
 */
export function loadContent(
  slots: HarnessSlotStore,
  links: Links,
  key: string,
  read: () => Promise<string>
): void {
  const existing = slots.get(links.content)[key]
  if (existing && existing.request !== 0) return
  const request = newRequest()
  slots.set(
    links.content,
    (prev): Readonly<Record<string, ContentState>> => ({
      ...prev,
      [key]: {
        phase: existing?.content != null ? "ready" : "loading",
        content: existing?.content ?? null,
        failure: null,
        request,
      },
    })
  )
  const current = () => slots.get(links.content)[key]?.request === request
  read().then(
    (content) => {
      if (!current()) return
      slots.set(
        links.content,
        (prev): Readonly<Record<string, ContentState>> => ({
          ...prev,
          [key]: { phase: "ready", content, failure: null, request },
        })
      )
    },
    (error: unknown) => {
      if (!current()) return
      slots.set(
        links.content,
        (prev): Readonly<Record<string, ContentState>> => ({
          ...prev,
          [key]: {
            phase: "error",
            content: prev[key]?.content ?? null,
            failure: skillsFailureOf(error),
            request,
          },
        })
      )
    }
  )
}

// ─── Writes in flight ─────────────────────────────────────────────────

export function isSkillBusy(busy: SkillBusy, skill: string): boolean {
  return (busy.writing[skill] ?? 0) > 0 || busy.awaiting[skill] !== undefined
}

function beginWrite(slots: HarnessSlotStore, links: Links, skills: string[]) {
  slots.set(links.busy, (prev) => {
    const writing = { ...prev.writing }
    for (const skill of skills) writing[skill] = (writing[skill] ?? 0) + 1
    return { ...prev, writing }
  })
}

function endWrite(
  slots: HarnessSlotStore,
  links: Links,
  skills: string[],
  refresh: number
) {
  slots.set(links.busy, (prev) => {
    const writing = { ...prev.writing }
    const awaiting = { ...prev.awaiting }
    for (const skill of skills) {
      const left = (writing[skill] ?? 1) - 1
      if (left > 0) writing[skill] = left
      else delete writing[skill]
      awaiting[skill] = refresh
    }
    return { writing, awaiting }
  })
}

/** A read has landed: the skills written before it began show the truth
 *  again, and the switches that only waited for it are free. */
function settleWrites(slots: HarnessSlotStore, links: Links, request: number) {
  slots.set(links.busy, (prev) => {
    const entries = Object.entries(prev.awaiting)
    if (!entries.some(([, waitingFor]) => waitingFor <= request)) return prev
    const awaiting: Record<string, number> = {}
    for (const [skill, waitingFor] of entries) {
      if (waitingFor > request) awaiting[skill] = waitingFor
    }
    return { ...prev, awaiting }
  })
  const busy = slots.get(links.busy)
  slots.set(links.writes, (prev): Readonly<Record<string, CellWrite>> => {
    const done = Object.entries(prev).filter(
      ([, write]) => write.phase === "saved" && !isSkillBusy(busy, write.skill)
    )
    if (done.length === 0) return prev
    const next = { ...prev }
    for (const [key] of done) delete next[key]
    return next
  })
}

function setWrite(
  slots: HarnessSlotStore,
  links: Links,
  key: string,
  seq: number,
  update: Partial<CellWrite>
) {
  slots.set(links.writes, (prev): Readonly<Record<string, CellWrite>> => {
    const write = prev[key]
    if (!write || write.seq !== seq) return prev
    return { ...prev, [key]: { ...write, ...update } }
  })
}

/** Put a switch's failed save out of sight. */
export function dismissWrite(
  slots: HarnessSlotStore,
  links: Links,
  skill: string,
  agent: string
): void {
  const key = cellKey(skill, agent)
  slots.set(links.writes, (prev): Readonly<Record<string, CellWrite>> => {
    if (!prev[key] || prev[key].phase === "saving") return prev
    const next = { ...prev }
    delete next[key]
    return next
  })
}

// ─── The confirmation ─────────────────────────────────────────────────

let lastDialog = 0

function setEffects(
  slots: HarnessSlotStore,
  links: Links,
  id: number,
  update: (dialog: EffectsDialog) => EffectsDialog
) {
  slots.set(links.effects, (prev) =>
    prev && prev.id === id ? update(prev) : prev
  )
}

export function closeEffects(
  slots: HarnessSlotStore,
  links: Links,
  id: number
): void {
  slots.set(links.effects, (prev) => (prev && prev.id === id ? null : prev))
}

/** A repair's answer, read as a plan of one op. */
function repairAsPlan(
  result: SkillsRepairResult,
  skill: string
): SkillsApplyResult {
  return {
    outcome: result.outcome,
    ok: result.ok,
    issues: [],
    ops: [
      {
        index: 0,
        skill: result.skill ?? skill,
        agent: "",
        action: result.action,
        status: result.status,
        creates: result.creates,
        removes: result.removes,
        moves: result.moves,
        gains: result.gains,
        loses: result.loses,
        touches: result.touches,
        ack: result.ack,
        issues: result.issues,
        warnings: result.warnings,
      },
    ],
  }
}

async function preflightOf(dialog: EffectsDialog): Promise<SkillsApplyResult> {
  if (dialog.repair) {
    const skill = dialog.intent.kind === "repair" ? dialog.intent.skill : ""
    return repairAsPlan(
      await skillsRepairLink({ ...dialog.repair, preflight: true }),
      skill
    )
  }
  return skillsApplyLinks({ ops: dialog.ops, preflight: true })
}

async function runWith(
  dialog: EffectsDialog,
  plan: SkillsApplyResult
): Promise<SkillsApplyResult> {
  if (dialog.repair) {
    const skill = dialog.intent.kind === "repair" ? dialog.intent.skill : ""
    return repairAsPlan(
      await skillsRepairLink({
        ...dialog.repair,
        ack: plan.ops[0]?.ack ?? null,
      }),
      skill
    )
  }
  return skillsApplyLinks({ ops: opsWithAcks(dialog.ops, plan) })
}

/**
 * Open the confirmation and plan what it asks for. The plan writes nothing.
 * With `quiet`, a plan that reaches no other agent and stops at nothing is
 * carried out at once, the dialog never shown — what a single switch does
 * when the engine says no one else is involved.
 */
export async function planEffects(
  slots: HarnessSlotStore,
  links: Links,
  request: {
    intent: EffectsIntent
    ops?: SkillOp[]
    repair?: { path: string; action: RepairAction }
    notice?: EffectsDialog["notice"]
    id?: number
    quiet?: boolean
  }
): Promise<void> {
  const id = request.id ?? ++lastDialog
  const seq = newRequest()
  const dialog: EffectsDialog = {
    id,
    intent: request.intent,
    ops: request.ops ?? [],
    repair: request.repair ?? null,
    step: "checking",
    plan: null,
    result: null,
    failure: null,
    notice: request.notice ?? null,
    quiet: request.quiet ?? false,
    request: seq,
  }
  slots.set(links.effects, dialog)
  const current = () => slots.get(links.effects)?.request === seq
  try {
    const plan = await preflightOf(dialog)
    if (!current()) return
    setEffects(slots, links, id, (prev) => ({
      ...prev,
      step: "review",
      plan,
      quiet: prev.quiet && !mustReview(plan),
    }))
    if (dialog.quiet && !mustReview(plan)) {
      return confirmEffects(slots, links, id)
    }
  } catch (error) {
    if (!current()) return
    setEffects(slots, links, id, (prev) => ({
      ...prev,
      step: "review",
      failure: skillsFailureOf(error),
      quiet: false,
    }))
  }
}

/** Whether the confirmation's plan can be carried out as it stands. */
export function canConfirm(dialog: EffectsDialog): boolean {
  if (dialog.step === "result") return dialog.result?.outcome === "busy"
  if (dialog.step !== "review" || !dialog.plan) return false
  return dialog.plan.outcome === "preflight" && dialog.plan.ok
}

/**
 * Carry out what the confirmation showed, with the acks of that plan. If its
 * effects changed in the meantime the engine writes nothing; the page then
 * plans again and shows the new plan, saying why. A busy lock is told as it
 * is, with a retry.
 */
export async function confirmEffects(
  slots: HarnessSlotStore,
  links: Links,
  id: number
): Promise<void> {
  const dialog = slots.get(links.effects)
  if (!dialog || dialog.id !== id || !canConfirm(dialog) || !dialog.plan) {
    return
  }
  const plan = dialog.plan
  const skills = dialog.repair
    ? plan.ops.map((op) => op.skill).filter(Boolean)
    : skillsOf(dialog.ops)
  const seq = newRequest()
  setEffects(slots, links, id, (prev) => ({
    ...prev,
    step: "saving",
    failure: null,
    request: seq,
  }))
  beginWrite(slots, links, skills)
  let result: SkillsApplyResult | null = null
  let failure: SkillsFailure | null = null
  try {
    result = await runWith(dialog, plan)
  } catch (error) {
    failure = skillsFailureOf(error)
  }
  const refresh = reloadInventory(slots, links)
  endWrite(slots, links, skills, refresh.request)
  if (slots.get(links.effects)?.request !== seq) return
  if (result?.outcome === "acknowledgement_required") {
    // Nothing was written: what it would do is no longer what was shown.
    return planEffects(slots, links, {
      id,
      intent: dialog.intent,
      ops: dialog.ops,
      repair: dialog.repair ?? undefined,
      notice: "effectsChanged",
    })
  }
  if (result && isApplied(result)) {
    closeEffects(slots, links, id)
    announce(slots, links, dialog.intent, true)
    return
  }
  setEffects(slots, links, id, (prev) => ({
    ...prev,
    step: "result",
    result,
    failure,
    quiet: false,
  }))
  if (result) announce(slots, links, dialog.intent, false)
}

function announce(
  slots: HarnessSlotStore,
  links: Links,
  intent: EffectsIntent,
  saved: boolean
) {
  const seq = newRequest()
  if (intent.kind === "toggle") {
    slots.set(links.announcement, {
      seq,
      skill: intent.skill,
      agent: intent.agent,
      on: intent.on,
      saved,
    })
  } else if (intent.kind === "only" || intent.kind === "refresh") {
    slots.set(links.announcement, {
      seq,
      skill: intent.skill,
      agent: intent.agent,
      on: true,
      saved,
    })
  } else if (intent.kind === "batch") {
    slots.set(links.announcement, {
      seq,
      skill: "",
      agent: null,
      on: intent.on,
      saved,
    })
  }
}

// ─── A switch ─────────────────────────────────────────────────────────

/**
 * Save one switch. When the engine's rules say the change may reach other
 * agents (`check`) it is planned first: if the plan reaches anyone else it
 * is shown and waits for the user; if not, it goes through as planned. A
 * change that cannot reach anyone else is saved at once — and should the
 * disk have changed meanwhile so that it now would, the engine refuses it
 * unwritten, and the plan it reports is shown instead.
 */
export async function writeCell(
  slots: HarnessSlotStore,
  links: Links,
  op: SkillOp,
  check: boolean
): Promise<void> {
  if (isSkillBusy(slots.get(links.busy), op.skill)) return
  const key = cellKey(op.skill, op.agent)
  const seq = newRequest()
  const on = op.action !== "disable"
  const intent: EffectsIntent = {
    kind: "toggle",
    skill: op.skill,
    agent: op.agent,
    on,
  }
  slots.set(
    links.writes,
    (prev): Readonly<Record<string, CellWrite>> => ({
      ...prev,
      [key]: {
        seq,
        skill: op.skill,
        agent: op.agent,
        on,
        phase: check ? "checking" : "saving",
        ops: [op],
        result: null,
        failure: null,
      },
    })
  )
  let ops = [op]
  if (check) {
    let plan: SkillsApplyResult
    try {
      plan = await skillsApplyLinks({ ops, preflight: true })
    } catch (error) {
      setWrite(slots, links, key, seq, {
        phase: "failed",
        failure: skillsFailureOf(error),
      })
      return
    }
    if (slots.get(links.writes)[key]?.seq !== seq) return
    if (mustReview(plan)) {
      dropWrite(slots, links, key, seq)
      slots.set(links.effects, {
        id: ++lastDialog,
        intent,
        ops,
        repair: null,
        step: "review",
        plan,
        result: null,
        failure: null,
        notice: null,
        quiet: false,
        request: newRequest(),
      })
      return
    }
    ops = opsWithAcks(ops, plan)
    setWrite(slots, links, key, seq, { phase: "saving" })
  }
  beginWrite(slots, links, [op.skill])
  let result: SkillsApplyResult | null = null
  let failure: SkillsFailure | null = null
  try {
    result = await skillsApplyLinks({ ops })
  } catch (error) {
    failure = skillsFailureOf(error)
  }
  // Read again whatever came of it: a busy lock may have been someone
  // else's save, and a refusal means the disk is not what was shown.
  const refresh = reloadInventory(slots, links)
  endWrite(slots, links, [op.skill], refresh.request)
  if (result?.outcome === "acknowledgement_required") {
    // Nothing was written. The plan the engine reports now is the question.
    dropWrite(slots, links, key, seq)
    void planEffects(slots, links, { intent, ops: [op] })
    return
  }
  const saved = result !== null && isApplied(result)
  setWrite(slots, links, key, seq, {
    phase: saved ? "saved" : "failed",
    result,
    failure,
  })
  slots.set(links.announcement, {
    seq: newRequest(),
    skill: op.skill,
    agent: op.agent,
    on,
    saved,
  })
}

function dropWrite(
  slots: HarnessSlotStore,
  links: Links,
  key: string,
  seq: number
) {
  slots.set(links.writes, (prev): Readonly<Record<string, CellWrite>> => {
    if (prev[key]?.seq !== seq) return prev
    const next = { ...prev }
    delete next[key]
    return next
  })
}

/** Retry a switch whose save failed, as it was asked. */
export function retryWrite(
  slots: HarnessSlotStore,
  links: Links,
  write: CellWrite
): void {
  dismissWrite(slots, links, write.skill, write.agent)
  const [op] = write.ops
  if (op) void writeCell(slots, links, { ...op, ack: null }, true)
}

// ─── What a control asks for ──────────────────────────────────────────

/** A switch was flipped: save it, planned first where the engine's rules
 *  say it may reach other agents. `ready` is false for a skill that cannot
 *  be switched on (not synced, name taken). */
export function requestToggle(
  slots: HarnessSlotStore,
  links: Links,
  skill: string,
  agent: AgentType,
  ready = true
): void {
  const model = currentModel(slots, links)
  if (!model) return
  const view = cellView(model.cell(skill, agent), model.agent(agent), ready)
  if (!view.toggle) return
  void writeCell(
    slots,
    links,
    { skill, agent, action: view.toggle },
    view.check
  )
}

/**
 * Switch many cells at once. Always planned: turning off is shown before it
 * is done, as it always was; turning on goes through at once unless the plan
 * reaches other agents or stops at something, which is then shown.
 */
export function requestBatch(
  slots: HarnessSlotStore,
  links: Links,
  targets: readonly CellTarget[],
  on: boolean,
  ready: (skill: string) => boolean = () => true
): void {
  const model = currentModel(slots, links)
  if (!model) return
  const ops = deltaOps(model, targets, on, ready)
  if (ops.length === 0) return
  void planEffects(slots, links, {
    intent: { kind: "batch", on },
    ops,
    quiet: on,
  })
}

/** "Only for this agent": move Codeg's link out of the shared directory into
 *  the agent's own. The others lose it, so it is always shown first. */
export function requestOnly(
  slots: HarnessSlotStore,
  links: Links,
  skill: string,
  agent: AgentType
): void {
  void planEffects(slots, links, {
    intent: { kind: "only", skill, agent },
    ops: [{ skill, agent, action: "only" }],
  })
}

/**
 * Bring an agent's copy up to date. A copy changed on the agent's side is
 * replaced only with `replace` — backed up first — and only once the user has
 * confirmed it; an outdated copy nobody changed is just refreshed.
 */
export function requestRefresh(
  slots: HarnessSlotStore,
  links: Links,
  skill: string,
  agent: AgentType,
  replace: boolean
): void {
  void planEffects(slots, links, {
    intent: { kind: "refresh", skill, agent, replace },
    ops: [
      {
        skill,
        agent,
        action: "refresh",
        ...(replace ? { replace_modified: true } : {}),
      },
    ],
    quiet: !replace,
  })
}

/** Re-point a broken link Codeg made, or remove it. Shown first only when it
 *  reaches other agents (a re-pointed link in a shared directory). */
export function requestRepair(
  slots: HarnessSlotStore,
  links: Links,
  skill: string,
  path: string,
  action: RepairAction
): void {
  void planEffects(slots, links, {
    intent: { kind: "repair", skill, path, action },
    repair: { path, action },
    quiet: true,
  })
}
