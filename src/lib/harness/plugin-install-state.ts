/**
 * Installing plugins from Harness: the state the install dialog is drawn
 * from, and the requests that fill it.
 *
 * The dialog shares the page's one Harness dialog slot with the MCP and
 * skill steps' (`MCP_HARNESS_DIALOG`), and the rules of
 * `skill-install-state.ts` hold here too: nothing installs but the dialog's
 * own button, only the newest answer lands, and what is installed is only
 * ever read (`harness_installed`, asked again after a change).
 *
 * A change of an agent's mode asks for a new plan for the modes chosen: the
 * revision they install, what must be agreed to, the links' previews and the
 * Experts takeovers are the plan's for exactly those modes. Every way an
 * install comes back without writing because what it would do moved — the
 * catalog's account, the effects on other agents, what runs on its own —
 * asks for a new plan too, to be confirmed as it is now.
 */
import type { HarnessSlotStore } from "@/lib/harness-slots"
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
  initialPluginInput,
  pluginInstallArgsOf,
  pluginTargetOf,
  plannedModeOf,
  samePluginModes,
  type PluginInstallInput,
} from "./plugin-install"
import { harnessPluginInstall, harnessPluginPlan } from "./plugin-install-api"
import type {
  HarnessPluginInstallResult,
  HarnessPluginPlan,
  PluginMode,
} from "./plugin-install-types"

// Outside the slots, for the reason `discover-state.ts` gives.
let lastRequest = 0
const newRequest = () => ++lastRequest

/** Refusals that mean the plan on show is no longer the one to confirm. */
const REPLAN_ISSUES = new Set([
  "plugin_consent_stale",
  "plugin_record_changed",
  "plugin_revision_not_target",
  "effects_changed",
  "acknowledgement_required",
])

export interface PluginInstallDialog {
  kind: "pluginInstall"
  id: number
  itemRef: string
  /** The item's title as the page that opened the dialog knew it. */
  knownTitle: { en?: string; zh?: string } | null
  from: "discover" | "plugins"
  planPhase: "loading" | "ready" | "error"
  plan: HarnessPluginPlan | null
  planFailure: HarnessFailure | null
  /** A plan for the modes chosen is on its way; the last stays on show,
   *  and nothing can be confirmed, until it is in. */
  replanning: boolean
  input: PluginInstallInput | null
  step: "input" | "installing" | "result"
  /** Why the last install was refused, shown over the input. */
  issues: HarnessReason[]
  /** The catalog's account changed since it was shown: what changed. */
  changes: HarnessReason[]
  result: HarnessPluginInstallResult | null
  /** The last request was rejected outright. Nothing was written. */
  failure: HarnessFailure | null
  notice: "effectsChanged" | "stateMoved" | null
  request: number
}

function pluginDialogOf(
  slots: HarnessSlotStore,
  id: number
): PluginInstallDialog | null {
  const dialog = slots.get(MCP_HARNESS_DIALOG)
  return dialog && dialog.id === id && dialog.kind === "pluginInstall"
    ? dialog
    : null
}

/** Open the install dialog on a plugin. It plans and shows; it never
 *  installs. Returns the dialog's id, or `null` when it was not opened (a
 *  Harness dialog is writing). */
export function openPluginInstall(
  slots: HarnessSlotStore,
  request: {
    itemRef: string
    title?: { en?: string; zh?: string } | null
    from: "discover" | "plugins"
  }
): number | null {
  if (isHarnessDialogWriting(slots)) return null
  const id = nextHarnessDialogId()
  slots.set(MCP_HARNESS_DIALOG, {
    kind: "pluginInstall",
    id,
    itemRef: request.itemRef,
    knownTitle: request.title ?? null,
    from: request.from,
    planPhase: "loading",
    plan: null,
    planFailure: null,
    replanning: false,
    input: null,
    step: "input",
    issues: [],
    changes: [],
    result: null,
    failure: null,
    notice: null,
    request: 0,
  })
  void planPluginInstall(slots, id)
  return id
}

/** The fingerprint of the revision the plan's modes install. */
function targetFingerprint(plan: HarnessPluginPlan): string | null {
  const planned = Object.fromEntries(
    plan.hosts.map((row) => [row.agent, plannedModeOf(row)])
  )
  return pluginTargetOf(plan, planned).state_sha256
}

/**
 * Ask for the plan — the first, or again: for the modes chosen (`modes`:
 * the dialog stays on show meanwhile, with the same rows), after a refusal,
 * or when the user asks. What the user chose is kept wherever the new plan
 * still offers it.
 */
export async function planPluginInstall(
  slots: HarnessSlotStore,
  id: number,
  options: {
    modes?: Readonly<Record<string, PluginMode>>
    issues?: HarnessReason[]
    changes?: HarnessReason[]
    notice?: PluginInstallDialog["notice"]
    /** Plans asked in a row without the user: bounded. */
    follow?: number
  } = {}
): Promise<void> {
  const dialog = pluginDialogOf(slots, id)
  if (!dialog || dialog.step === "installing") return
  const request = newRequest()
  const quiet = options.modes !== undefined && dialog.plan !== null
  updateHarnessDialog(slots, id, "pluginInstall", (prev) => ({
    ...prev,
    planPhase: quiet ? prev.planPhase : "loading",
    replanning: quiet,
    planFailure: quiet ? prev.planFailure : null,
    step: "input",
    issues: options.issues ?? [],
    changes: options.changes ?? [],
    failure: null,
    notice: options.notice ?? null,
    request,
  }))
  const current = () => pluginDialogOf(slots, id)?.request === request
  try {
    const plan = await harnessPluginPlan(dialog.itemRef, {
      // The same rows as the plan on show.
      agents: dialog.plan?.hosts.map((row) => row.agent) ?? null,
      modes: options.modes ?? null,
    })
    if (!current()) return
    const before = pluginDialogOf(slots, id)?.plan ?? null
    const input = initialPluginInput(
      plan,
      pluginDialogOf(slots, id)?.input ?? null
    )
    const moved =
      before !== null &&
      targetFingerprint(before) !== null &&
      targetFingerprint(before) !== targetFingerprint(plan)
    updateHarnessDialog(slots, id, "pluginInstall", (prev) => ({
      ...prev,
      planPhase: "ready",
      planFailure: null,
      replanning: false,
      plan,
      input,
      result: null,
      notice: moved && !prev.notice ? "stateMoved" : prev.notice,
    }))
    // The plan is for other modes than those chosen (the user's kept over
    // the plan's defaults): asked again for exactly those.
    const planned = Object.fromEntries(
      plan.hosts.map((row) => [row.agent, plannedModeOf(row)])
    )
    const follow = options.follow ?? 0
    if (!samePluginModes(planned, input.modes) && follow < 2) {
      void planPluginInstall(slots, id, {
        modes: input.modes,
        issues: options.issues,
        changes: options.changes,
        notice: moved ? "stateMoved" : options.notice,
        follow: follow + 1,
      })
    }
  } catch (error) {
    if (!current()) return
    updateHarnessDialog(slots, id, "pluginInstall", (prev) => ({
      ...prev,
      planPhase: "error",
      replanning: false,
      planFailure: harnessFailureOf(error),
    }))
  }
}

/** Change what the user put in. Not while an install is on its way. A
 *  change of modes asks for a new plan for them. */
export function updatePluginInput(
  slots: HarnessSlotStore,
  id: number,
  update: (
    input: PluginInstallInput,
    plan: HarnessPluginPlan
  ) => PluginInstallInput
): void {
  const dialog = pluginDialogOf(slots, id)
  if (!dialog?.plan || !dialog.input || dialog.step !== "input") return
  const before = dialog.input.modes
  updateHarnessDialog(slots, id, "pluginInstall", (prev) =>
    prev.plan && prev.input && prev.step === "input"
      ? { ...prev, input: update(prev.input, prev.plan) }
      : prev
  )
  const after = pluginDialogOf(slots, id)?.input?.modes
  if (after && !samePluginModes(before, after)) {
    void planPluginInstall(slots, id, { modes: after })
  }
}

/** The call the dialog's confirm button would make now, or `null`. */
export function pluginInstallArgsOfDialog(dialog: PluginInstallDialog) {
  if (!dialog.plan || !dialog.input || dialog.planPhase !== "ready") {
    return null
  }
  if (dialog.replanning) return null
  return pluginInstallArgsOf(dialog.itemRef, dialog.plan, dialog.input)
}

export function canConfirmPluginInstall(dialog: PluginInstallDialog): boolean {
  const step =
    dialog.step === "input" ||
    (dialog.step === "result" && dialog.result?.outcome === "busy")
  return step && pluginInstallArgsOfDialog(dialog) !== null
}

/**
 * Install what the dialog shows — the user pressed its confirm button. Each
 * way it can come back is shown for what it is:
 *
 * - `installed`: each agent's step.
 * - `refused`: back to the input, with why — planned again where the plan
 *   on show is no longer the one to confirm (what runs on its own changed,
 *   the record moved, the effects on other agents moved).
 * - `acknowledgement_required`, `state_changed`: planned again, with what
 *   changed, to be confirmed as it is now.
 * - `aborted`, `invalid_package`, `busy`, `failed`: why; `busy` is retried
 *   on request.
 */
export async function confirmPluginInstall(
  slots: HarnessSlotStore,
  id: number
): Promise<void> {
  const dialog = pluginDialogOf(slots, id)
  if (!dialog || !canConfirmPluginInstall(dialog)) return
  const args = pluginInstallArgsOfDialog(dialog)
  if (!args) return
  const request = newRequest()
  updateHarnessDialog(slots, id, "pluginInstall", (prev) => ({
    ...prev,
    step: "installing",
    issues: [],
    changes: [],
    failure: null,
    notice: null,
    request,
  }))
  let result: HarnessPluginInstallResult | null = null
  let failure: HarnessFailure | null = null
  try {
    result = await harnessPluginInstall(args)
  } catch (error) {
    failure = harnessFailureOf(error)
  }
  if (
    result?.outcome === "installed" ||
    result?.outcome === "failed" ||
    result?.outcome === "refused"
  ) {
    void reloadHarnessInstalled(slots)
  }
  if (pluginDialogOf(slots, id)?.request !== request) return
  const backToInput = () =>
    updateHarnessDialog(slots, id, "pluginInstall", (prev) =>
      prev.step === "installing" ? { ...prev, step: "input" } : prev
    )
  if (!result) {
    updateHarnessDialog(slots, id, "pluginInstall", (prev) =>
      failure?.kind === "resolveUnavailable"
        ? { ...prev, step: "input", planPhase: "error", planFailure: failure }
        : { ...prev, step: "input", failure }
    )
    return
  }
  const outcome = result
  const modes = dialog.input?.modes
  switch (outcome.outcome) {
    case "refused": {
      const issues = outcome.issues
      if (issues.some((issue) => REPLAN_ISSUES.has(issue.code))) {
        backToInput()
        return planPluginInstall(slots, id, { modes, issues })
      }
      updateHarnessDialog(slots, id, "pluginInstall", (prev) => ({
        ...prev,
        step: "input",
        issues,
      }))
      return
    }
    case "acknowledgement_required":
      backToInput()
      return planPluginInstall(slots, id, {
        modes,
        notice: "effectsChanged",
      })
    case "state_changed":
      backToInput()
      return planPluginInstall(slots, id, {
        modes,
        changes: outcome.changes,
        notice: "stateMoved",
      })
    default:
      updateHarnessDialog(slots, id, "pluginInstall", (prev) => ({
        ...prev,
        step: "result",
        result: outcome,
      }))
  }
}

/** Back to the input from a result (after `busy`). */
export function backToPluginInput(slots: HarnessSlotStore, id: number): void {
  updateHarnessDialog(slots, id, "pluginInstall", (prev) =>
    prev.step === "result" ? { ...prev, step: "input" } : prev
  )
}
