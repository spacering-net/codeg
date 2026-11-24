/**
 * Managing an installed plugin: the state its dialogs are drawn from, and
 * the requests that fill them — the update dialog (`harness_plugin_plan_
 * update` → `harness_plugin_update`), the change dialog for one agent's mode,
 * on and off, and repair (`harness_plugin_set_host`, `_set_enabled`,
 * `_repair`, each asked first with `preflight`), and the uninstall dialog.
 *
 * They share the page's one Harness dialog slot (`MCP_HARNESS_DIALOG`) and
 * the rules of `plugin-install-state.ts`: nothing is written but by the
 * dialog's own button, only the newest answer lands, and every way a call
 * comes back without writing because what it would do moved asks again, to
 * be confirmed as it is now.
 */
import { defineHarnessSlot, type HarnessSlotStore } from "@/lib/harness-slots"
import { harnessFailureOf, type HarnessFailure } from "./errors"
import {
  isHarnessDialogWriting,
  MCP_HARNESS_DIALOG,
  nextHarnessDialogId,
  reloadHarnessInstalled,
  updateHarnessDialog,
} from "./mcp-install-state"
import type { HarnessReason } from "./mcp-install-types"
import {
  EMPTY_UPDATE_INPUT,
  pluginChangeCallOf,
  pluginChangePreflightOf,
  pluginUpdateArgsOf,
  type PluginChangeAction,
  type PluginChangeCall,
  type PluginChangeInput,
  type PluginUpdateInput,
} from "./plugin-manage"
import {
  harnessPluginPlanUpdate,
  harnessPluginRepair,
  harnessPluginSetEnabled,
  harnessPluginSetHost,
  harnessPluginUninstall,
  harnessPluginUpdate,
} from "./plugin-install-api"
import type {
  HarnessHookTrust,
  HarnessPluginInstallResult,
  HarnessPluginUninstallResult,
  HarnessPluginUpdatePlan,
} from "./plugin-install-types"
import { reloadHarnessUpdates } from "./updates"

// Outside the slots, for the reason `discover-state.ts` gives.
let lastRequest = 0
const newRequest = () => ++lastRequest

/** Refusals that mean what is on show is no longer what would be done. */
const AGAIN_ISSUES = new Set([
  "plugin_consent_stale",
  "plugin_record_changed",
  "plugin_revision_not_target",
  "effects_changed",
  "acknowledgement_required",
])

/** The plugin a dialog is about, as the row that opened it knew it. */
export interface PluginDialogSubject {
  itemId: string
  itemRef: string
  /** The install name. */
  name: string
}

/** Codex's trust of one agent's hooks, as the Plugins section asked it:
 *  `read` tells one read from the next, so only the newest lands. */
export type PluginHookTrustState =
  | { phase: "loading"; read: number }
  | { phase: "ready"; value: HarnessHookTrust }
  | { phase: "error"; failure: HarnessFailure }

/** Codex's trust of a plugin's hooks, by item, revision and agent (the
 *  Plugins section's keys): asked only when the user asks. */
export const PLUGIN_HOOK_TRUST = defineHarnessSlot<
  Readonly<Record<string, PluginHookTrustState>>
>("plugins", () => ({}))

/** Before a write: no trust read before it — or still on its way — stands
 *  for after it. Codex forgets a plugin's hook trust when it takes the
 *  plugin out, and a write may do that and put it back (a rollback), at the
 *  same revision, for the same agent. */
function forgetHookTrust(slots: HarnessSlotStore) {
  slots.set(PLUGIN_HOOK_TRUST, {})
}

/** After a write: read again what is installed and what the check says of
 *  it, since the update marks are read against it. */
function afterWrite(slots: HarnessSlotStore) {
  void reloadHarnessInstalled(slots)
  void reloadHarnessUpdates(slots)
}

// ─── Update ───────────────────────────────────────────────────────────

export interface PluginUpdateDialog {
  kind: "pluginUpdate"
  id: number
  subject: PluginDialogSubject
  planPhase: "loading" | "ready" | "error"
  plan: HarnessPluginUpdatePlan | null
  planFailure: HarnessFailure | null
  input: PluginUpdateInput
  step: "input" | "updating" | "result"
  issues: HarnessReason[]
  changes: HarnessReason[]
  result: HarnessPluginInstallResult | null
  failure: HarnessFailure | null
  notice: "effectsChanged" | "stateMoved" | null
  request: number
}

function updateDialogOf(
  slots: HarnessSlotStore,
  id: number
): PluginUpdateDialog | null {
  const dialog = slots.get(MCP_HARNESS_DIALOG)
  return dialog && dialog.id === id && dialog.kind === "pluginUpdate"
    ? dialog
    : null
}

/** Open the update dialog on an installed plugin. It plans and shows; it
 *  never updates. `null` when a Harness dialog is writing. */
export function openPluginUpdate(
  slots: HarnessSlotStore,
  subject: PluginDialogSubject
): number | null {
  if (isHarnessDialogWriting(slots)) return null
  const id = nextHarnessDialogId()
  slots.set(MCP_HARNESS_DIALOG, {
    kind: "pluginUpdate",
    id,
    subject,
    planPhase: "loading",
    plan: null,
    planFailure: null,
    input: EMPTY_UPDATE_INPUT,
    step: "input",
    issues: [],
    changes: [],
    result: null,
    failure: null,
    notice: null,
    request: 0,
  })
  void planPluginUpdate(slots, id)
  return id
}

/** Ask for the update plan — the first, or again. The agreement and the
 *  withdrawn-version tick are kept; the agreement counts only for the new
 *  plan's `exec_sha256`. */
export async function planPluginUpdate(
  slots: HarnessSlotStore,
  id: number,
  options: {
    issues?: HarnessReason[]
    changes?: HarnessReason[]
    notice?: PluginUpdateDialog["notice"]
  } = {}
): Promise<void> {
  const dialog = updateDialogOf(slots, id)
  if (!dialog || dialog.step === "updating") return
  const request = newRequest()
  updateHarnessDialog(slots, id, "pluginUpdate", (prev) => ({
    ...prev,
    planPhase: "loading",
    planFailure: null,
    step: "input",
    issues: options.issues ?? [],
    changes: options.changes ?? [],
    failure: null,
    notice: options.notice ?? null,
    request,
  }))
  const current = () => updateDialogOf(slots, id)?.request === request
  try {
    const plan = await harnessPluginPlanUpdate(dialog.subject.itemId)
    if (!current()) return
    updateHarnessDialog(slots, id, "pluginUpdate", (prev) => ({
      ...prev,
      planPhase: "ready",
      plan,
      result: null,
    }))
  } catch (error) {
    if (!current()) return
    updateHarnessDialog(slots, id, "pluginUpdate", (prev) => ({
      ...prev,
      planPhase: "error",
      planFailure: harnessFailureOf(error),
    }))
  }
}

export function updatePluginUpdateInput(
  slots: HarnessSlotStore,
  id: number,
  update: (input: PluginUpdateInput) => PluginUpdateInput
): void {
  updateHarnessDialog(slots, id, "pluginUpdate", (prev) =>
    prev.step === "input" ? { ...prev, input: update(prev.input) } : prev
  )
}

export function pluginUpdateArgsOfDialog(dialog: PluginUpdateDialog) {
  if (!dialog.plan || dialog.planPhase !== "ready") return null
  return pluginUpdateArgsOf(dialog.subject.itemId, dialog.plan, dialog.input)
}

export function canConfirmPluginUpdate(dialog: PluginUpdateDialog): boolean {
  const step =
    dialog.step === "input" ||
    (dialog.step === "result" && dialog.result?.outcome === "busy")
  return step && pluginUpdateArgsOfDialog(dialog) !== null
}

/** Update what the dialog shows — the user pressed its button. */
export async function confirmPluginUpdate(
  slots: HarnessSlotStore,
  id: number
): Promise<void> {
  const dialog = updateDialogOf(slots, id)
  if (!dialog || !canConfirmPluginUpdate(dialog)) return
  const args = pluginUpdateArgsOfDialog(dialog)
  if (!args) return
  const request = newRequest()
  forgetHookTrust(slots)
  updateHarnessDialog(slots, id, "pluginUpdate", (prev) => ({
    ...prev,
    step: "updating",
    issues: [],
    changes: [],
    failure: null,
    notice: null,
    request,
  }))
  let result: HarnessPluginInstallResult | null = null
  let failure: HarnessFailure | null = null
  try {
    result = await harnessPluginUpdate(args)
  } catch (error) {
    failure = harnessFailureOf(error)
  }
  if (
    result?.outcome === "updated" ||
    result?.outcome === "failed" ||
    result?.outcome === "refused"
  ) {
    afterWrite(slots)
  }
  if (updateDialogOf(slots, id)?.request !== request) return
  const backToInput = () =>
    updateHarnessDialog(slots, id, "pluginUpdate", (prev) =>
      prev.step === "updating" ? { ...prev, step: "input" } : prev
    )
  if (!result) {
    updateHarnessDialog(slots, id, "pluginUpdate", (prev) => ({
      ...prev,
      step: "input",
      failure,
    }))
    return
  }
  const outcome = result
  switch (outcome.outcome) {
    case "refused":
      backToInput()
      if (outcome.issues.some((issue) => AGAIN_ISSUES.has(issue.code))) {
        return planPluginUpdate(slots, id, { issues: outcome.issues })
      }
      updateHarnessDialog(slots, id, "pluginUpdate", (prev) => ({
        ...prev,
        issues: outcome.issues,
      }))
      return
    case "acknowledgement_required":
      backToInput()
      return planPluginUpdate(slots, id, { notice: "effectsChanged" })
    case "state_changed":
      backToInput()
      return planPluginUpdate(slots, id, {
        changes: outcome.changes,
        notice: "stateMoved",
      })
    default:
      updateHarnessDialog(slots, id, "pluginUpdate", (prev) => ({
        ...prev,
        step: "result",
        result: outcome,
      }))
  }
}

export function backToPluginUpdateInput(
  slots: HarnessSlotStore,
  id: number
): void {
  updateHarnessDialog(slots, id, "pluginUpdate", (prev) =>
    prev.step === "result" ? { ...prev, step: "input" } : prev
  )
}

// ─── A change for one agent, and repair ───────────────────────────────

export interface PluginChangeDialog {
  kind: "pluginChange"
  id: number
  subject: PluginDialogSubject
  action: PluginChangeAction
  phase: "checking" | "ready" | "writing" | "result"
  /** What the change would do: the preflight's answer, with its acks. */
  preflight: HarnessPluginInstallResult | null
  input: PluginChangeInput
  /** `state_changed`: what changed in the catalog's account. */
  changes: HarnessReason[]
  result: HarnessPluginInstallResult | null
  failure: HarnessFailure | null
  notice: "effectsChanged" | "stateMoved" | null
  request: number
}

function changeDialogOf(
  slots: HarnessSlotStore,
  id: number
): PluginChangeDialog | null {
  const dialog = slots.get(MCP_HARNESS_DIALOG)
  return dialog && dialog.id === id && dialog.kind === "pluginChange"
    ? dialog
    : null
}

function callChange(
  call: PluginChangeCall
): Promise<HarnessPluginInstallResult> {
  switch (call.command) {
    case "set_host":
      return harnessPluginSetHost(call.args)
    case "set_enabled":
      return harnessPluginSetEnabled(call.args)
    case "repair":
      return harnessPluginRepair(call.args)
  }
}

/** Open the change dialog, and ask at once what the change would do. */
export function openPluginChange(
  slots: HarnessSlotStore,
  subject: PluginDialogSubject,
  action: PluginChangeAction
): number | null {
  if (isHarnessDialogWriting(slots)) return null
  const id = nextHarnessDialogId()
  slots.set(MCP_HARNESS_DIALOG, {
    kind: "pluginChange",
    id,
    subject,
    action,
    phase: "checking",
    preflight: null,
    input: { consentExec: null },
    changes: [],
    result: null,
    failure: null,
    notice: null,
    request: 0,
  })
  void preflightPluginChange(slots, id)
  return id
}

/** Ask what the change would do. Writes nothing. */
export async function preflightPluginChange(
  slots: HarnessSlotStore,
  id: number,
  options: {
    changes?: HarnessReason[]
    notice?: PluginChangeDialog["notice"]
  } = {}
): Promise<void> {
  const dialog = changeDialogOf(slots, id)
  if (!dialog || dialog.phase === "writing") return
  const request = newRequest()
  updateHarnessDialog(slots, id, "pluginChange", (prev) => ({
    ...prev,
    phase: "checking",
    changes: options.changes ?? [],
    failure: null,
    notice: options.notice ?? null,
    request,
  }))
  const current = () => changeDialogOf(slots, id)?.request === request
  try {
    const preflight = await callChange(
      pluginChangePreflightOf(dialog.subject.itemId, dialog.action)
    )
    if (!current()) return
    updateHarnessDialog(slots, id, "pluginChange", (prev) => ({
      ...prev,
      phase: "ready",
      preflight,
      result: null,
    }))
  } catch (error) {
    if (!current()) return
    updateHarnessDialog(slots, id, "pluginChange", (prev) => ({
      ...prev,
      phase: "ready",
      preflight: null,
      failure: harnessFailureOf(error),
    }))
  }
}

/**
 * Agree (or not) to what runs on its own. `shownExec` is the `exec_sha256`
 * of what the dialog lists: the agreement is given only while it is the
 * preflight's — what is agreed to is what was shown.
 */
export function setPluginChangeConsent(
  slots: HarnessSlotStore,
  id: number,
  agree: boolean,
  shownExec: string | null
): void {
  updateHarnessDialog(slots, id, "pluginChange", (prev) =>
    prev.phase === "ready" && prev.preflight
      ? {
          ...prev,
          input: {
            consentExec:
              agree &&
              shownExec !== null &&
              shownExec === prev.preflight.consent_exec
                ? shownExec
                : null,
          },
        }
      : prev
  )
}

export function pluginChangeCallOfDialog(
  dialog: PluginChangeDialog
): PluginChangeCall | null {
  if (!dialog.preflight) return null
  return pluginChangeCallOf(
    dialog.subject.itemId,
    dialog.action,
    dialog.preflight,
    dialog.input
  )
}

export function canConfirmPluginChange(dialog: PluginChangeDialog): boolean {
  const step =
    dialog.phase === "ready" ||
    (dialog.phase === "result" && dialog.result?.outcome === "busy")
  return step && pluginChangeCallOfDialog(dialog) !== null
}

/** Make the change the preflight showed. */
export async function confirmPluginChange(
  slots: HarnessSlotStore,
  id: number
): Promise<void> {
  const dialog = changeDialogOf(slots, id)
  if (!dialog || !canConfirmPluginChange(dialog)) return
  const call = pluginChangeCallOfDialog(dialog)
  if (!call) return
  const request = newRequest()
  forgetHookTrust(slots)
  updateHarnessDialog(slots, id, "pluginChange", (prev) => ({
    ...prev,
    phase: "writing",
    changes: [],
    failure: null,
    notice: null,
    request,
  }))
  let result: HarnessPluginInstallResult | null = null
  let failure: HarnessFailure | null = null
  try {
    result = await callChange(call)
  } catch (error) {
    failure = harnessFailureOf(error)
  }
  if (
    result?.outcome === "changed" ||
    result?.outcome === "repaired" ||
    result?.outcome === "failed" ||
    result?.outcome === "refused"
  ) {
    afterWrite(slots)
  }
  if (changeDialogOf(slots, id)?.request !== request) return
  if (!result) {
    updateHarnessDialog(slots, id, "pluginChange", (prev) => ({
      ...prev,
      phase: "ready",
      failure,
    }))
    return
  }
  const outcome = result
  if (
    outcome.outcome === "acknowledgement_required" ||
    (outcome.outcome === "refused" &&
      outcome.issues.some((issue) => AGAIN_ISSUES.has(issue.code)))
  ) {
    updateHarnessDialog(slots, id, "pluginChange", (prev) => ({
      ...prev,
      phase: "ready",
    }))
    return preflightPluginChange(slots, id, { notice: "effectsChanged" })
  }
  if (outcome.outcome === "state_changed") {
    updateHarnessDialog(slots, id, "pluginChange", (prev) => ({
      ...prev,
      phase: "ready",
    }))
    return preflightPluginChange(slots, id, {
      changes: outcome.changes,
      notice: "stateMoved",
    })
  }
  updateHarnessDialog(slots, id, "pluginChange", (prev) => ({
    ...prev,
    phase: "result",
    result: outcome,
  }))
}

// ─── Uninstall ────────────────────────────────────────────────────────

export interface PluginUninstallDialog {
  kind: "pluginUninstall"
  id: number
  subject: PluginDialogSubject
  phase: "checking" | "ready" | "uninstalling" | "result"
  /** What it would do: the preflight's account, with its `ack`. */
  preflight: HarnessPluginUninstallResult | null
  result: HarnessPluginUninstallResult | null
  failure: HarnessFailure | null
  notice: "effectsChanged" | null
  request: number
}

function uninstallDialogOf(
  slots: HarnessSlotStore,
  id: number
): PluginUninstallDialog | null {
  const dialog = slots.get(MCP_HARNESS_DIALOG)
  return dialog && dialog.id === id && dialog.kind === "pluginUninstall"
    ? dialog
    : null
}

/** Open the uninstall dialog, and ask at once what uninstalling would do. */
export function openPluginUninstall(
  slots: HarnessSlotStore,
  subject: PluginDialogSubject
): number | null {
  if (isHarnessDialogWriting(slots)) return null
  const id = nextHarnessDialogId()
  slots.set(MCP_HARNESS_DIALOG, {
    kind: "pluginUninstall",
    id,
    subject,
    phase: "checking",
    preflight: null,
    result: null,
    failure: null,
    notice: null,
    request: 0,
  })
  void preflightPluginUninstall(slots, id)
  return id
}

export async function preflightPluginUninstall(
  slots: HarnessSlotStore,
  id: number,
  notice: PluginUninstallDialog["notice"] = null
): Promise<void> {
  const dialog = uninstallDialogOf(slots, id)
  if (!dialog || dialog.phase === "uninstalling") return
  const request = newRequest()
  updateHarnessDialog(slots, id, "pluginUninstall", (prev) => ({
    ...prev,
    phase: "checking",
    failure: null,
    notice,
    request,
  }))
  const current = () => uninstallDialogOf(slots, id)?.request === request
  try {
    const preflight = await harnessPluginUninstall({
      itemId: dialog.subject.itemId,
      preflight: true,
    })
    if (!current()) return
    updateHarnessDialog(slots, id, "pluginUninstall", (prev) => ({
      ...prev,
      phase: "ready",
      preflight,
      result: null,
    }))
  } catch (error) {
    if (!current()) return
    updateHarnessDialog(slots, id, "pluginUninstall", (prev) => ({
      ...prev,
      phase: "ready",
      preflight: null,
      failure: harnessFailureOf(error),
    }))
  }
}

/** Whether the uninstall may go now: the account on show is a preflight.
 *  Its `ack` is sent back as it came — `null` when nothing it does needs one
 *  (no skills links to remove: a plugin installed whole only). */
export function canConfirmPluginUninstall(
  dialog: PluginUninstallDialog
): boolean {
  const step =
    dialog.phase === "ready" ||
    (dialog.phase === "result" && dialog.result?.outcome === "busy")
  const preflight = dialog.preflight
  return step && preflight !== null && preflight.outcome === "preflight"
}

export async function confirmPluginUninstall(
  slots: HarnessSlotStore,
  id: number
): Promise<void> {
  const dialog = uninstallDialogOf(slots, id)
  if (!dialog || !canConfirmPluginUninstall(dialog) || !dialog.preflight) {
    return
  }
  const ack = dialog.preflight.ack
  const request = newRequest()
  forgetHookTrust(slots)
  updateHarnessDialog(slots, id, "pluginUninstall", (prev) => ({
    ...prev,
    phase: "uninstalling",
    failure: null,
    notice: null,
    request,
  }))
  let result: HarnessPluginUninstallResult | null = null
  let failure: HarnessFailure | null = null
  try {
    result = await harnessPluginUninstall({
      itemId: dialog.subject.itemId,
      ack,
    })
  } catch (error) {
    failure = harnessFailureOf(error)
  }
  if (
    result?.outcome === "uninstalled" ||
    result?.outcome === "write_failed" ||
    result?.outcome === "refused"
  ) {
    afterWrite(slots)
  }
  if (uninstallDialogOf(slots, id)?.request !== request) return
  if (!result) {
    updateHarnessDialog(slots, id, "pluginUninstall", (prev) => ({
      ...prev,
      phase: "ready",
      failure,
    }))
    return
  }
  const outcome = result
  if (outcome.outcome === "acknowledgement_required") {
    // Nothing was written; the answer is what it would do now, with the
    // ack for exactly that.
    updateHarnessDialog(slots, id, "pluginUninstall", (prev) => ({
      ...prev,
      phase: "ready",
      preflight: outcome.ack ? { ...outcome, outcome: "preflight" } : null,
      notice: "effectsChanged",
    }))
    if (!outcome.ack) void preflightPluginUninstall(slots, id, "effectsChanged")
    return
  }
  updateHarnessDialog(slots, id, "pluginUninstall", (prev) => ({
    ...prev,
    phase: "result",
    result: outcome,
  }))
}
