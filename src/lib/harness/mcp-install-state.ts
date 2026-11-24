/**
 * Installing, updating and uninstalling MCP servers from Harness: the state
 * the dialogs and the marks are drawn from, and the requests that fill it.
 *
 * Kept in slots (`harness-slots.ts`), like the rest of the Harness page, so a
 * dialog in progress — the way of running it that was chosen, what was typed,
 * the agents ticked — is still there after a trip to a conversation, and an
 * install started just before the page was left still has somewhere to land.
 * Slots are memory: secrets typed into the dialog are never written to
 * storage, and they go with the dialog when it is closed, or once the install
 * went through.
 *
 * Three rules hold throughout:
 *
 * - **Nothing installs but a confirmation.** Opening the dialog — from a
 *   link, from Discover, from the MCP section — only plans. The install is
 *   called from the dialog's own buttons, with what the dialog showed.
 * - **Only the newest answer lands.** Every request has a number, and an
 *   answer to anything but the dialog's latest request (or for a dialog that
 *   is gone) is dropped.
 * - **What is installed is only ever read.** After any change, and on
 *   `harness://installed-changed`, `harness_installed` is asked again; the
 *   listing is never patched from a result.
 */
import { defineHarnessSlot, type HarnessSlotStore } from "@/lib/harness-slots"
import { basisFromResult } from "@/lib/mcp/ops"
import { isMcpAppType, type McpAppType } from "@/lib/mcp/types"
import { DISCOVER_DETAIL, openDiscoverItem } from "./discover-state"
import { knownKind } from "./display"
import { harnessFailureOf, type HarnessFailure } from "./errors"
import {
  harnessInstalled,
  harnessMcpInstall,
  harnessMcpPlan,
  harnessMcpUninstall,
} from "./mcp-install-api"
import {
  initialInput,
  installArgsOf,
  type McpInstallInput,
  type McpInstallRestate,
} from "./mcp-install"
import type {
  HarnessInstalled,
  HarnessInstalledItem,
  HarnessMcpInstallResult,
  HarnessMcpPlan,
  HarnessMcpUninstallResult,
  HarnessReason,
} from "./mcp-install-types"
import type { PluginInstallDialog } from "./plugin-install-state"
import type {
  PluginChangeDialog,
  PluginUninstallDialog,
  PluginUpdateDialog,
} from "./plugin-manage-state"
import type { SkillHarnessDialog } from "./skill-install-state"

// One counter for every request here, outside the slots for the reason
// `discover-state.ts` gives.
let lastRequest = 0
const newRequest = () => ++lastRequest
let lastDialog = 0

// ─── What is installed ────────────────────────────────────────────────

export interface HarnessInstalledState {
  phase: "idle" | "loading" | "ready" | "error"
  /** The last listing — kept while a new one is read, and when that fails. */
  value: HarnessInstalled | null
  failure: HarnessFailure | null
  request: number
}

export const HARNESS_INSTALLED = defineHarnessSlot<HarnessInstalledState>(
  "mcp",
  () => ({ phase: "idle", value: null, failure: null, request: 0 })
)

/** Ask the host again what it has installed from Harness. */
export async function reloadHarnessInstalled(
  slots: HarnessSlotStore
): Promise<void> {
  const request = newRequest()
  slots.set(
    HARNESS_INSTALLED,
    (prev): HarnessInstalledState => ({ ...prev, phase: "loading", request })
  )
  const current = () => slots.get(HARNESS_INSTALLED).request === request
  try {
    const value = await harnessInstalled()
    if (!current()) return
    slots.set(
      HARNESS_INSTALLED,
      (prev): HarnessInstalledState => ({
        ...prev,
        phase: "ready",
        value,
        failure: null,
      })
    )
  } catch (error) {
    if (!current()) return
    slots.set(
      HARNESS_INSTALLED,
      (prev): HarnessInstalledState => ({
        ...prev,
        phase: "error",
        failure: harnessFailureOf(error),
      })
    )
  }
}

export function installedItemById(
  slots: HarnessSlotStore,
  itemId: string
): HarnessInstalledItem | null {
  return (
    slots
      .get(HARNESS_INSTALLED)
      .value?.mcp.find((item) => item.id === itemId) ?? null
  )
}

// ─── The dialogs ──────────────────────────────────────────────────────

/** What a dialog was opened for. The plan has the last word: "update" on an
 *  item that is not installed is an install, and so on. */
export type McpInstallPurpose = "install" | "update" | "manage"

export interface McpInstallDialog {
  kind: "install"
  id: number
  /** The address the plan is asked for. */
  itemRef: string
  /** The item's title as the page that opened the dialog knew it — what the
   *  dialog is called until the plan, with its own, is in. */
  knownTitle: { en?: string; zh?: string } | null
  purpose: McpInstallPurpose
  /** The revision asked for; `null` for the newest. */
  revision: number | null
  /** Where it was opened: from Discover, the result offers the MCP
   *  section. */
  from: "discover" | "mcp"
  planPhase: "loading" | "ready" | "error"
  plan: HarnessMcpPlan | null
  planFailure: HarnessFailure | null
  input: McpInstallInput | null
  /** After `state_changed`: the state the next confirmation is of. */
  restate: McpInstallRestate | null
  step: "input" | "installing" | "stateChanged" | "result"
  /** Why the last install was refused, shown over the input. */
  issues: HarnessReason[]
  result: HarnessMcpInstallResult | null
  /** The last install was rejected outright. Nothing was written. */
  failure: HarnessFailure | null
  /** The plan was made again because an agent's file changed under the
   *  dialog. */
  notice: "changedElsewhere" | null
  request: number
}

export interface McpUninstallSelection {
  agents: McpAppType[]
  removeChanged: McpAppType[]
}

export interface McpUninstallDialog {
  kind: "uninstall"
  id: number
  itemId: string
  itemRef: string
  key: string
  /** The agents ticked to remove it from. */
  agents: McpAppType[]
  /** Agents whose entry was changed here, ticked to be removed anyway. */
  removeChanged: McpAppType[]
  phase: "checking" | "ready" | "uninstalling" | "result"
  /** The backend's report of what the selection would do. */
  preflight: HarnessMcpUninstallResult | null
  /** The selection that report is for. */
  checked: McpUninstallSelection | null
  result: HarnessMcpUninstallResult | null
  failure: HarnessFailure | null
  notice: "changedElsewhere" | null
  request: number
}

/** Every dialog the page's one Harness dialog slot holds: the MCP install
 *  step's two, and the skill install step's (`skill-install-state.ts`). One
 *  slot, so that one Harness dialog is open at a time. */
export type McpHarnessDialog =
  | McpInstallDialog
  | McpUninstallDialog
  | SkillHarnessDialog
  | PluginInstallDialog
  | PluginUpdateDialog
  | PluginChangeDialog
  | PluginUninstallDialog

export const MCP_HARNESS_DIALOG = defineHarnessSlot<McpHarnessDialog | null>(
  "mcp",
  () => null
)

type DialogOf<K extends McpHarnessDialog["kind"]> = Extract<
  McpHarnessDialog,
  { kind: K }
>

function dialogOf<K extends McpHarnessDialog["kind"]>(
  slots: HarnessSlotStore,
  id: number,
  kind: K
): DialogOf<K> | null {
  const dialog = slots.get(MCP_HARNESS_DIALOG)
  return dialog && dialog.id === id && dialog.kind === kind
    ? (dialog as DialogOf<K>)
    : null
}

/** Change the open dialog — only if it is still the one `id` names. */
export function updateHarnessDialog<K extends McpHarnessDialog["kind"]>(
  slots: HarnessSlotStore,
  id: number,
  kind: K,
  update: (dialog: DialogOf<K>) => DialogOf<K>
): void {
  slots.set(MCP_HARNESS_DIALOG, (prev) =>
    prev && prev.id === id && prev.kind === kind
      ? update(prev as DialogOf<K>)
      : prev
  )
}

/** A dialog whose write is on its way: nothing replaces or closes it before
 *  its answer is shown. */
function isWriting(dialog: McpHarnessDialog | null): boolean {
  return (
    (dialog?.kind === "install" && dialog.step === "installing") ||
    (dialog?.kind === "uninstall" && dialog.phase === "uninstalling") ||
    (dialog?.kind === "skillInstall" && dialog.step === "installing") ||
    (dialog?.kind === "skillUninstall" && dialog.phase === "uninstalling") ||
    (dialog?.kind === "pluginInstall" && dialog.step === "installing") ||
    (dialog?.kind === "pluginUpdate" && dialog.step === "updating") ||
    (dialog?.kind === "pluginChange" && dialog.phase === "writing") ||
    (dialog?.kind === "pluginUninstall" && dialog.phase === "uninstalling")
  )
}

/** Whether the open Harness dialog, of any kind, is writing: a new one must
 *  not take its place before its answer is shown. */
export function isHarnessDialogWriting(slots: HarnessSlotStore): boolean {
  return isWriting(slots.get(MCP_HARNESS_DIALOG))
}

/** A new dialog's id: one counter for every kind the slot holds, so no two
 *  dialogs ever share one. */
export function nextHarnessDialogId(): number {
  return ++lastDialog
}

/**
 * Close a dialog — and with it everything typed into it. Not while its
 * write is in flight: the answer has to be shown.
 */
export function closeHarnessDialog(slots: HarnessSlotStore, id: number): void {
  slots.set(MCP_HARNESS_DIALOG, (prev) => {
    if (!prev || prev.id !== id || isWriting(prev)) return prev
    return null
  })
}

// ─── Install ──────────────────────────────────────────────────────────

/**
 * Open the install dialog on an item. It plans and shows; it never installs.
 * Opening one replaces whatever Harness dialog was open, as any new dialog
 * does — except one whose write is on its way (a link arriving meanwhile
 * opens its item's detail, and no more). Returns the dialog's id, or `null`
 * when it was not opened.
 */
export function openMcpInstall(
  slots: HarnessSlotStore,
  request: {
    itemRef: string
    /** The title the opener already has, if any. */
    title?: { en?: string; zh?: string } | null
    purpose: McpInstallPurpose
    revision?: number | null
    from: "discover" | "mcp"
  }
): number | null {
  if (isWriting(slots.get(MCP_HARNESS_DIALOG))) return null
  const id = ++lastDialog
  slots.set(MCP_HARNESS_DIALOG, {
    kind: "install",
    id,
    itemRef: request.itemRef,
    knownTitle: request.title ?? null,
    purpose: request.purpose,
    revision: request.revision ?? null,
    from: request.from,
    planPhase: "loading",
    plan: null,
    planFailure: null,
    input: null,
    restate: null,
    step: "input",
    issues: [],
    result: null,
    failure: null,
    notice: null,
    request: 0,
  })
  void planMcpInstall(slots, id)
  return id
}

/**
 * Ask for the plan — again, over one already on show, after a file changed
 * under the dialog or when the user asks. What the user put in is kept
 * wherever the new plan still allows it (`initialInput`); the state they
 * would confirm is the new plan's.
 */
export async function planMcpInstall(
  slots: HarnessSlotStore,
  id: number,
  options: {
    notice?: McpInstallDialog["notice"]
    issues?: HarnessReason[]
  } = {}
): Promise<void> {
  const dialog = dialogOf(slots, id, "install")
  if (!dialog) return
  const request = newRequest()
  updateHarnessDialog(slots, id, "install", (prev) => ({
    ...prev,
    planPhase: "loading",
    planFailure: null,
    step: "input",
    issues: options.issues ?? [],
    failure: null,
    notice: options.notice ?? null,
    request,
  }))
  const current = () => dialogOf(slots, id, "install")?.request === request
  try {
    const plan = await harnessMcpPlan(dialog.itemRef, dialog.revision)
    if (!current()) return
    updateHarnessDialog(slots, id, "install", (prev) => ({
      ...prev,
      planPhase: "ready",
      plan,
      input: initialInput(plan, prev.input),
      restate: null,
      result: null,
    }))
  } catch (error) {
    if (!current()) return
    updateHarnessDialog(slots, id, "install", (prev) => ({
      ...prev,
      planPhase: "error",
      planFailure: harnessFailureOf(error),
    }))
  }
}

/** Change what the user put in. Not while an install is on its way: what
 *  is being installed is what was confirmed. */
export function updateInstallInput(
  slots: HarnessSlotStore,
  id: number,
  update: (input: McpInstallInput, plan: HarnessMcpPlan) => McpInstallInput
): void {
  updateHarnessDialog(slots, id, "install", (prev) =>
    prev.plan && prev.input && prev.step === "input"
      ? { ...prev, input: update(prev.input, prev.plan) }
      : prev
  )
}

/** Whether the dialog's confirm button may install now. */
export function canConfirmInstall(dialog: McpInstallDialog): boolean {
  if (!dialog.plan || !dialog.input || dialog.planPhase !== "ready") {
    return false
  }
  const step =
    dialog.step === "input" ||
    dialog.step === "stateChanged" ||
    (dialog.step === "result" && dialog.result?.outcome === "busy")
  return (
    step &&
    installArgsOf(dialog.itemRef, dialog.plan, dialog.input, dialog.restate) !==
      null
  )
}

/**
 * Install what the dialog shows — the user pressed its confirm button. The
 * call is built from the plan and the input alone (`installArgsOf`); each way
 * it can come back is shown for what it is:
 *
 * - `installed`: each agent's result; what was typed is forgotten.
 * - `refused`: back to the input, with why. Installed meanwhile under
 *   another name: planned again.
 * - `changed_elsewhere`: planned again, keeping the input; confirm again.
 * - `state_changed`: the changes and the new state, to be confirmed again —
 *   the next call carries the new fingerprint.
 * - `aborted`: why it can no longer be installed; nothing to confirm.
 * - `invalid`, `busy`, `write_failed`: each agent's result, as a save in the
 *   MCP section shows it (a busy lock can be retried).
 */
export async function confirmMcpInstall(
  slots: HarnessSlotStore,
  id: number
): Promise<void> {
  const dialog = dialogOf(slots, id, "install")
  if (!dialog || !canConfirmInstall(dialog) || !dialog.plan || !dialog.input) {
    return
  }
  const args = installArgsOf(
    dialog.itemRef,
    dialog.plan,
    dialog.input,
    dialog.restate
  )
  if (!args) return
  const request = newRequest()
  updateHarnessDialog(slots, id, "install", (prev) => ({
    ...prev,
    step: "installing",
    issues: [],
    failure: null,
    notice: null,
    request,
  }))
  let result: HarnessMcpInstallResult | null = null
  let failure: HarnessFailure | null = null
  try {
    result = await harnessMcpInstall(args)
  } catch (error) {
    failure = harnessFailureOf(error)
  }
  // Whatever became of the dialog, the host's record may have changed.
  if (
    result?.outcome === "installed" ||
    result?.outcome === "write_failed" ||
    result?.outcome === "refused"
  ) {
    void reloadHarnessInstalled(slots)
  }
  if (dialogOf(slots, id, "install")?.request !== request) return
  if (!result) {
    updateHarnessDialog(slots, id, "install", (prev) =>
      failure?.kind === "resolveUnavailable"
        ? // The catalog cannot say how the version stands now: what the
          // dialog showed can no longer be confirmed. It says so, with
          // nothing to confirm, until a new plan is had.
          { ...prev, step: "input", planPhase: "error", planFailure: failure }
        : {
            ...prev,
            step: prev.restate ? "stateChanged" : "input",
            failure,
          }
    )
    return
  }
  switch (result.outcome) {
    case "installed":
      updateHarnessDialog(slots, id, "install", (prev) => ({
        ...prev,
        step: "result",
        result,
        // Done with: secrets go now, not when the dialog closes — those
        // typed, and those the plan read back from the agents' entries.
        input: prev.input ? { ...prev.input, values: {} } : prev.input,
        plan: prev.plan ? withoutRecoveredValues(prev.plan) : prev.plan,
      }))
      return
    case "refused": {
      const issues = result.issues
      if (issues.some((issue) => issue.code === "installed_under_other_key")) {
        return planMcpInstall(slots, id, { issues })
      }
      updateHarnessDialog(slots, id, "install", (prev) => ({
        ...prev,
        step: "input",
        issues,
      }))
      return
    }
    case "changed_elsewhere":
      return planMcpInstall(slots, id, { notice: "changedElsewhere" })
    case "state_changed": {
      const stateSha256 = result.state_sha256
      const outcome = result
      updateHarnessDialog(slots, id, "install", (prev) =>
        stateSha256
          ? {
              ...prev,
              step: "stateChanged",
              restate: {
                snapshot: outcome.snapshot,
                stateSha256,
                changes: outcome.changes,
              },
            }
          : { ...prev, step: "result", result: outcome }
      )
      return
    }
    default:
      updateHarnessDialog(slots, id, "install", (prev) => ({
        ...prev,
        step: "result",
        result,
      }))
  }
}

/** The plan without the values it read back from the agents' entries. */
function withoutRecoveredValues(plan: HarnessMcpPlan): HarnessMcpPlan {
  return {
    ...plan,
    options: plan.options.map((option) => ({
      ...option,
      parameters: option.parameters.map((parameter) =>
        parameter.current ? { ...parameter, current: null } : parameter
      ),
    })),
  }
}

/**
 * Back to the input from a later step. After the catalog's account changed,
 * the plan is asked for again: its ways of running the server (the pinned
 * command, their warnings) were made from the old account, and the input
 * must not show one thing while the next call confirms another. What the
 * user put in is kept wherever the new plan allows it.
 */
export function backToInstallInput(slots: HarnessSlotStore, id: number): void {
  const dialog = dialogOf(slots, id, "install")
  if (!dialog || dialog.step === "installing") return
  if (dialog.restate) {
    void planMcpInstall(slots, id)
    return
  }
  updateHarnessDialog(slots, id, "install", (prev) => ({
    ...prev,
    step: "input",
  }))
}

/**
 * `openHarness({ section: "discover", itemRef, intent: "install" })`: show
 * the item, and once it is in, offer the install dialog — for an MCP server
 * only. A skill keeps to its detail (its dialog is another step's); any other
 * kind has nothing to install. Nothing is installed: the dialog asks.
 */
export async function openDiscoverItemToInstall(
  slots: HarnessSlotStore,
  itemRef: string
): Promise<void> {
  const loading = openDiscoverItem(slots, itemRef)
  const request = slots.get(DISCOVER_DETAIL)?.request
  await loading
  const detail = slots.get(DISCOVER_DETAIL)
  if (
    !detail ||
    detail.request !== request ||
    detail.phase !== "ready" ||
    !detail.item ||
    knownKind(detail.item.kind) !== "mcp"
  ) {
    return
  }
  openMcpInstall(slots, {
    itemRef: detail.item.ref,
    title: detail.item.title,
    purpose: "install",
    from: "discover",
  })
}

// ─── Uninstall ────────────────────────────────────────────────────────

const knownAgents = (agents: readonly string[]): McpAppType[] =>
  agents.filter(isMcpAppType)

/** Open the uninstall dialog for an installed item: every agent it is
 *  recorded in is ticked, and the backend is asked at once what that would
 *  do. */
export function openMcpUninstall(
  slots: HarnessSlotStore,
  itemId: string
): void {
  const item = installedItemById(slots, itemId)
  if (!item || isWriting(slots.get(MCP_HARNESS_DIALOG))) return
  const id = ++lastDialog
  slots.set(MCP_HARNESS_DIALOG, {
    kind: "uninstall",
    id,
    itemId: item.id,
    itemRef: item.ref,
    key: item.key,
    agents: knownAgents(item.agents.map((agent) => agent.agent)),
    removeChanged: [],
    phase: "checking",
    preflight: null,
    checked: null,
    result: null,
    failure: null,
    notice: null,
    request: 0,
  })
  void preflightMcpUninstall(slots, id)
}

const sameAgents = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((agent) => b.includes(agent))

/** Ask what the current selection would do. Writes nothing. */
export async function preflightMcpUninstall(
  slots: HarnessSlotStore,
  id: number,
  options: { notice?: McpUninstallDialog["notice"] } = {}
): Promise<void> {
  const dialog = dialogOf(slots, id, "uninstall")
  if (!dialog || dialog.phase === "uninstalling") return
  const request = newRequest()
  const selection: McpUninstallSelection = {
    agents: [...dialog.agents],
    removeChanged: dialog.removeChanged.filter((agent) =>
      dialog.agents.includes(agent)
    ),
  }
  updateHarnessDialog(slots, id, "uninstall", (prev) => ({
    ...prev,
    phase: "checking",
    failure: null,
    notice: options.notice ?? null,
    request,
  }))
  const current = () => dialogOf(slots, id, "uninstall")?.request === request
  try {
    const preflight = await harnessMcpUninstall({
      itemId: dialog.itemId,
      agents: selection.agents,
      removeChanged: selection.removeChanged,
      preflight: true,
    })
    if (!current()) return
    updateHarnessDialog(slots, id, "uninstall", (prev) => ({
      ...prev,
      phase: "ready",
      preflight,
      checked: selection,
      result: null,
    }))
  } catch (error) {
    if (!current()) return
    updateHarnessDialog(slots, id, "uninstall", (prev) => ({
      ...prev,
      phase: "ready",
      preflight: null,
      checked: null,
      failure: harnessFailureOf(error),
    }))
  }
}

/** Tick or untick an agent, or a changed entry's removal — and ask again
 *  what that would do. */
export function changeUninstallSelection(
  slots: HarnessSlotStore,
  id: number,
  change: { agent: McpAppType; list: "agents" | "removeChanged"; on: boolean }
): void {
  const dialog = dialogOf(slots, id, "uninstall")
  if (!dialog || dialog.phase === "uninstalling") return
  const list = dialog[change.list].filter((agent) => agent !== change.agent)
  if (change.on) list.push(change.agent)
  updateHarnessDialog(slots, id, "uninstall", (prev) => ({
    ...prev,
    [change.list]: list,
  }))
  void preflightMcpUninstall(slots, id)
}

/** The agents the uninstall would take the server out of, by the report on
 *  show. */
export function uninstallRemovals(dialog: McpUninstallDialog): string[] {
  return (dialog.preflight?.agents ?? [])
    .filter((agent) => agent.action === "remove")
    .map((agent) => agent.agent)
}

/** Whether the uninstall may go now: the report on show is for the
 *  selection on show, says nothing stops it, and something would change. */
export function canConfirmUninstall(dialog: McpUninstallDialog): boolean {
  const { preflight, checked } = dialog
  const step =
    dialog.phase === "ready" ||
    (dialog.phase === "result" && dialog.result?.outcome === "busy")
  if (!step || !preflight || !checked) return false
  if (preflight.outcome !== "preflight") return false
  if (preflight.apply && !preflight.apply.ok) return false
  if (
    !sameAgents(checked.agents, dialog.agents) ||
    !sameAgents(
      checked.removeChanged,
      dialog.removeChanged.filter((agent) => dialog.agents.includes(agent))
    )
  ) {
    return false
  }
  return preflight.agents.some(
    (agent) => agent.action === "remove" || agent.action === "forget"
  )
}

/** Uninstall what the report showed, with the basis it found for each agent
 *  the server is taken out of. */
export async function confirmMcpUninstall(
  slots: HarnessSlotStore,
  id: number
): Promise<void> {
  const dialog = dialogOf(slots, id, "uninstall")
  if (!dialog || !canConfirmUninstall(dialog) || !dialog.checked) return
  const removals = new Set(uninstallRemovals(dialog))
  const found = dialog.preflight?.apply
    ? basisFromResult(dialog.preflight.apply)
    : {}
  const basis = Object.fromEntries(
    Object.entries(found).filter(([agent]) => removals.has(agent))
  )
  const selection = dialog.checked
  const request = newRequest()
  updateHarnessDialog(slots, id, "uninstall", (prev) => ({
    ...prev,
    phase: "uninstalling",
    failure: null,
    notice: null,
    request,
  }))
  let result: HarnessMcpUninstallResult | null = null
  let failure: HarnessFailure | null = null
  try {
    result = await harnessMcpUninstall({
      itemId: dialog.itemId,
      agents: selection.agents,
      removeChanged: selection.removeChanged,
      basis,
    })
  } catch (error) {
    failure = harnessFailureOf(error)
  }
  if (result && result.outcome !== "changed_elsewhere") {
    void reloadHarnessInstalled(slots)
  }
  if (dialogOf(slots, id, "uninstall")?.request !== request) return
  if (!result) {
    updateHarnessDialog(slots, id, "uninstall", (prev) => ({
      ...prev,
      phase: "ready",
      failure,
    }))
    return
  }
  if (result.outcome === "changed_elsewhere") {
    updateHarnessDialog(slots, id, "uninstall", (prev) => ({
      ...prev,
      phase: "ready",
    }))
    return preflightMcpUninstall(slots, id, { notice: "changedElsewhere" })
  }
  const outcome = result
  updateHarnessDialog(slots, id, "uninstall", (prev) => ({
    ...prev,
    phase: "result",
    result: outcome,
  }))
}
