/**
 * Installing, updating and uninstalling skills from Harness: the state the
 * dialogs are drawn from, and the requests that fill it.
 *
 * The dialogs share the page's one Harness dialog slot with the MCP install
 * step's (`MCP_HARNESS_DIALOG`), so one Harness dialog is open at a time and
 * a dialog in progress — the agents ticked, the name typed, `allowed-tools`,
 * the withdrawn version accepted — is still there after a trip to a
 * conversation; an install started just before the page was left still has
 * somewhere to land.
 *
 * The rules of `mcp-install-state.ts` hold here too:
 *
 * - **Nothing installs but a confirmation.** Opening the dialog — from a
 *   link, from Discover, from the Skills section — only plans. The install is
 *   called from the dialog's own buttons, with what the dialog showed.
 * - **Only the newest answer lands.** Every request has a number, and an
 *   answer to anything but the dialog's latest request (or for a dialog that
 *   is gone) is dropped.
 * - **What is installed is only ever read.** After a change, and on
 *   `harness://installed-changed`, `harness_installed` is asked again.
 */
import type { HarnessSlotStore } from "@/lib/harness-slots"
import type { AgentType } from "@/lib/types"
import { DISCOVER_DETAIL, openDiscoverItem } from "./discover-state"
import { knownKind } from "./display"
import { harnessFailureOf, type HarnessFailure } from "./errors"
import {
  HARNESS_INSTALLED,
  isHarnessDialogWriting,
  MCP_HARNESS_DIALOG,
  nextHarnessDialogId,
  openMcpInstall,
  reloadHarnessInstalled,
  updateHarnessDialog,
} from "./mcp-install-state"
import type { HarnessReason, HarnessVersionState } from "./mcp-install-types"
import {
  initialSkillInput,
  orderedAgents,
  skillInstallArgsOf,
  skillInstallModeOf,
  type SkillInstallInput,
  type SkillInstallRelinks,
  type SkillInstallRestate,
} from "./skill-install"
import {
  harnessSkillInstall,
  harnessSkillPlan,
  harnessSkillUninstall,
} from "./skill-install-api"
import type {
  HarnessInstalledSkill,
  HarnessSkillInstallResult,
  HarnessSkillPlan,
  HarnessSkillUninstallResult,
} from "./skill-install-types"

// Outside the slots, for the reason `discover-state.ts` gives.
let lastRequest = 0
const newRequest = () => ++lastRequest

// ─── The dialogs ──────────────────────────────────────────────────────

/** What a dialog was opened for. The plan has the last word: "update" on a
 *  skill that is not installed is an install, and so on. */
export type SkillInstallPurpose = "install" | "update"

export interface SkillInstallBaseline {
  phase: "loading" | "ready" | "error"
  /** The installed revision. */
  revision: number
  /** Its state, read fresh from the catalog; `null` when it gave none. */
  snapshot: HarnessVersionState | null
}

export interface SkillInstallDialog {
  kind: "skillInstall"
  id: number
  /** The address the plan is asked for. */
  itemRef: string
  /** The item's title as the page that opened the dialog knew it — what the
   *  dialog is called until the plan, with its own, is in. */
  knownTitle: { en?: string; zh?: string } | null
  purpose: SkillInstallPurpose
  /** The revision asked for; `null` for the newest. */
  revision: number | null
  /** Where it was opened: from Discover, the result offers the Skills
   *  section. */
  from: "discover" | "skills"
  planPhase: "loading" | "ready" | "error"
  plan: HarnessSkillPlan | null
  planFailure: HarnessFailure | null
  /** The agents the plan's link preview is for. */
  planAgents: AgentType[] | null
  /** A new plan is on its way for the agents ticked; the last one stays on
   *  show, and nothing can be confirmed, until it is in. */
  replanning: boolean
  input: SkillInstallInput | null
  /** After `state_changed`: the state the next confirmation is of. */
  restate: SkillInstallRestate | null
  /** After `acknowledgement_required`: the link preview for what was sent. */
  relinks: SkillInstallRelinks | null
  /** An update: the installed revision's state, to say what grew. */
  baseline: SkillInstallBaseline | null
  step: "input" | "installing" | "stateChanged" | "result"
  /** Why the last install was refused, shown over the input. */
  issues: HarnessReason[]
  result: HarnessSkillInstallResult | null
  /** The last request was rejected outright. Nothing was written. */
  failure: HarnessFailure | null
  /**
   * `effectsChanged`: what linking does is not what was shown (or the name
   * chosen reaches other agents), and has to be confirmed as it is now.
   * `stateMoved`: a new plan brought another account of the version.
   */
  notice: "effectsChanged" | "stateMoved" | null
  request: number
}

export interface SkillUninstallDialog {
  kind: "skillUninstall"
  id: number
  itemId: string
  itemRef: string
  /** The install name: the store id. */
  name: string
  phase: "checking" | "ready" | "uninstalling" | "result"
  /** What it would do: the preflight's account, with its `ack`. */
  preflight: HarnessSkillUninstallResult | null
  result: HarnessSkillUninstallResult | null
  failure: HarnessFailure | null
  /** What it would do changed since it was shown. */
  notice: "effectsChanged" | null
  request: number
}

export type SkillHarnessDialog = SkillInstallDialog | SkillUninstallDialog

function skillDialogOf<K extends SkillHarnessDialog["kind"]>(
  slots: HarnessSlotStore,
  id: number,
  kind: K
): Extract<SkillHarnessDialog, { kind: K }> | null {
  const dialog = slots.get(MCP_HARNESS_DIALOG)
  return dialog && dialog.id === id && dialog.kind === kind
    ? (dialog as Extract<SkillHarnessDialog, { kind: K }>)
    : null
}

export function installedSkillById(
  slots: HarnessSlotStore,
  itemId: string
): HarnessInstalledSkill | null {
  return (
    slots
      .get(HARNESS_INSTALLED)
      .value?.skills.find((skill) => skill.id === itemId) ?? null
  )
}

// ─── Install ──────────────────────────────────────────────────────────

/**
 * Open the install dialog on a skill. It plans and shows; it never installs.
 * Opening one replaces whatever Harness dialog was open — except one whose
 * write is on its way. Returns the dialog's id, or `null` when it was not
 * opened.
 */
export function openSkillInstall(
  slots: HarnessSlotStore,
  request: {
    itemRef: string
    /** The title the opener already has, if any. */
    title?: { en?: string; zh?: string } | null
    purpose: SkillInstallPurpose
    revision?: number | null
    from: "discover" | "skills"
  }
): number | null {
  if (isHarnessDialogWriting(slots)) return null
  const id = nextHarnessDialogId()
  slots.set(MCP_HARNESS_DIALOG, {
    kind: "skillInstall",
    id,
    itemRef: request.itemRef,
    knownTitle: request.title ?? null,
    purpose: request.purpose,
    revision: request.revision ?? null,
    from: request.from,
    planPhase: "loading",
    plan: null,
    planFailure: null,
    planAgents: null,
    replanning: false,
    input: null,
    restate: null,
    relinks: null,
    baseline: null,
    step: "input",
    issues: [],
    result: null,
    failure: null,
    notice: null,
    request: 0,
  })
  void planSkillInstall(slots, id)
  return id
}

/**
 * Ask for the plan — the first, or again: after the user ticked other
 * agents (`agents`: the preview is then for them, and the dialog stays on
 * show meanwhile), after a refusal, or when the user asks. What the user put
 * in is kept wherever the new plan allows it; the state they would confirm
 * is the new plan's.
 */
export async function planSkillInstall(
  slots: HarnessSlotStore,
  id: number,
  options: {
    agents?: readonly AgentType[]
    issues?: HarnessReason[]
    notice?: SkillInstallDialog["notice"]
    /** Plans asked in a row without the user: bounded, so that a host
     *  whose answers keep moving cannot keep the dialog asking. */
    follow?: number
  } = {}
): Promise<void> {
  const dialog = skillDialogOf(slots, id, "skillInstall")
  if (!dialog || dialog.step === "installing") return
  const request = newRequest()
  const quiet = options.agents !== undefined && dialog.plan !== null
  updateHarnessDialog(slots, id, "skillInstall", (prev) => ({
    ...prev,
    planPhase: quiet ? prev.planPhase : "loading",
    replanning: quiet,
    planFailure: quiet ? prev.planFailure : null,
    step: "input",
    issues: options.issues ?? [],
    failure: null,
    notice: options.notice ?? null,
    request,
  }))
  const current = () =>
    skillDialogOf(slots, id, "skillInstall")?.request === request
  try {
    const plan = await harnessSkillPlan(
      dialog.itemRef,
      dialog.revision,
      options.agents ?? null
    )
    if (!current()) return
    const before = skillDialogOf(slots, id, "skillInstall")?.plan ?? null
    const input = initialSkillInput(
      plan,
      skillDialogOf(slots, id, "skillInstall")?.input ?? null
    )
    // The preview is for what the plan was asked about — or, unasked, for
    // its default agents.
    const planAgents = orderedAgents(
      plan,
      options.agents ?? plan.default_agents
    )
    const moved =
      before !== null &&
      before.state_sha256 !== null &&
      before.state_sha256 !== plan.state_sha256
    updateHarnessDialog(slots, id, "skillInstall", (prev) => ({
      ...prev,
      planPhase: "ready",
      planFailure: null,
      replanning: false,
      plan,
      planAgents,
      input,
      restate: null,
      result: null,
      notice: moved ? "stateMoved" : prev.notice,
    }))
    // The preview is for other agents than those ticked — the plan's own
    // choice can hold one with nowhere to link, or lack one that sees the
    // skill already: asked again for exactly what is ticked.
    const follow = options.follow ?? 0
    if (!sameList(planAgents, input.agents) && follow < 2) {
      void planSkillInstall(slots, id, {
        agents: input.agents,
        notice: moved ? "stateMoved" : options.notice,
        follow: follow + 1,
      })
      return
    }
    void loadBaseline(slots, id, plan)
  } catch (error) {
    if (!current()) return
    updateHarnessDialog(slots, id, "skillInstall", (prev) => ({
      ...prev,
      planPhase: "error",
      replanning: false,
      planFailure: harnessFailureOf(error),
    }))
  }
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((agent) => b.includes(agent))

/**
 * An update: what the catalog says of the installed revision, read fresh, so
 * the dialog can list what the new one asks for that it did not. Asked once
 * per dialog and revision; shown beside the plan, never confirmed.
 */
async function loadBaseline(
  slots: HarnessSlotStore,
  id: number,
  plan: HarnessSkillPlan
): Promise<void> {
  const installed = plan.installed
  if (!installed || skillInstallModeOf(plan) !== "update") return
  const dialog = skillDialogOf(slots, id, "skillInstall")
  if (
    !dialog ||
    (dialog.baseline && dialog.baseline.revision === installed.revision)
  ) {
    return
  }
  const revision = installed.revision
  updateHarnessDialog(slots, id, "skillInstall", (prev) => ({
    ...prev,
    baseline: { phase: "loading", revision, snapshot: null },
  }))
  const current = () =>
    skillDialogOf(slots, id, "skillInstall")?.baseline?.revision === revision
  try {
    const old = await harnessSkillPlan(
      plan.item.ref || dialog.itemRef,
      revision
    )
    if (!current()) return
    updateHarnessDialog(slots, id, "skillInstall", (prev) => ({
      ...prev,
      baseline: { phase: "ready", revision, snapshot: old.snapshot },
    }))
  } catch {
    if (!current()) return
    updateHarnessDialog(slots, id, "skillInstall", (prev) => ({
      ...prev,
      baseline: { phase: "error", revision, snapshot: null },
    }))
  }
}

/** Change what the user put in. Not while an install is on its way: what
 *  is being installed is what was confirmed. A change of agents asks for a
 *  new plan, so that the links shown are the links of what is ticked. */
export function updateSkillInput(
  slots: HarnessSlotStore,
  id: number,
  update: (
    input: SkillInstallInput,
    plan: HarnessSkillPlan
  ) => SkillInstallInput
): void {
  const dialog = skillDialogOf(slots, id, "skillInstall")
  if (!dialog?.plan || !dialog.input || dialog.step !== "input") return
  const before = dialog.input.agents
  updateHarnessDialog(slots, id, "skillInstall", (prev) =>
    prev.plan && prev.input && prev.step === "input"
      ? { ...prev, input: update(prev.input, prev.plan) }
      : prev
  )
  const after = skillDialogOf(slots, id, "skillInstall")?.input?.agents
  if (after && !sameList(before, after)) {
    void planSkillInstall(slots, id, { agents: after })
  }
}

/** Leave the writing step for the input — once an answer says nothing was
 *  written. */
function backToInput(slots: HarnessSlotStore, id: number) {
  updateHarnessDialog(slots, id, "skillInstall", (prev) =>
    prev.step === "installing" ? { ...prev, step: "input" } : prev
  )
}

/** The call the dialog's confirm button would make now, or `null`. */
export function skillInstallArgsOfDialog(dialog: SkillInstallDialog) {
  if (!dialog.plan || !dialog.input || dialog.planPhase !== "ready") {
    return null
  }
  if (dialog.replanning) return null
  return skillInstallArgsOf(
    dialog.itemRef,
    dialog.plan,
    dialog.input,
    dialog.restate,
    dialog.planAgents,
    dialog.relinks
  )
}

/** Whether the dialog's confirm button may install now. */
export function canConfirmSkillInstall(dialog: SkillInstallDialog): boolean {
  const step =
    dialog.step === "input" ||
    dialog.step === "stateChanged" ||
    (dialog.step === "result" && dialog.result?.outcome === "busy")
  return step && skillInstallArgsOfDialog(dialog) !== null
}

/**
 * Install what the dialog shows — the user pressed its confirm button. The
 * call is built from the plan, the input and the link preview on show alone
 * (`skillInstallArgsOf`); each way it can come back is shown for what it is:
 *
 * - `installed`: each agent's link, the copies, the backup.
 * - `refused`: back to the input, with why. Installed meanwhile under
 *   another name: planned again.
 * - `acknowledgement_required`: what linking does now (for the name and the
 *   agents sent), to be confirmed — the next call carries its acks.
 * - `state_changed`: the changes and the new state, to be confirmed again —
 *   the next call carries the new fingerprint.
 * - `aborted`, `invalid_package`: why; nothing to confirm.
 * - `busy`: nothing written, retried on request. `write_failed`: what
 *   happened, step by step.
 */
export async function confirmSkillInstall(
  slots: HarnessSlotStore,
  id: number
): Promise<void> {
  const dialog = skillDialogOf(slots, id, "skillInstall")
  if (!dialog || !canConfirmSkillInstall(dialog)) return
  const args = skillInstallArgsOfDialog(dialog)
  if (!args) return
  const request = newRequest()
  updateHarnessDialog(slots, id, "skillInstall", (prev) => ({
    ...prev,
    step: "installing",
    issues: [],
    failure: null,
    notice: null,
    request,
  }))
  let result: HarnessSkillInstallResult | null = null
  let failure: HarnessFailure | null = null
  try {
    result = await harnessSkillInstall(args)
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
  if (skillDialogOf(slots, id, "skillInstall")?.request !== request) return
  if (!result) {
    updateHarnessDialog(slots, id, "skillInstall", (prev) =>
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
  const outcome = result
  switch (outcome.outcome) {
    case "refused": {
      const issues = outcome.issues
      if (issues.some((issue) => issue.code === "installed_under_other_name")) {
        // Out of the writing step first: the plan is asked again, and the
        // next install is the user's to confirm.
        backToInput(slots, id)
        return planSkillInstall(slots, id, { issues })
      }
      updateHarnessDialog(slots, id, "skillInstall", (prev) => ({
        ...prev,
        step: prev.restate ? "stateChanged" : "input",
        issues,
      }))
      return
    }
    case "acknowledgement_required": {
      const links = outcome.links
      if (!links) {
        // No preview to show: ask for the plan again rather than confirm
        // effects nobody saw.
        backToInput(slots, id)
        return planSkillInstall(slots, id, { notice: "effectsChanged" })
      }
      updateHarnessDialog(slots, id, "skillInstall", (prev) => ({
        ...prev,
        step: "input",
        relinks: { links, name: args.installName, agents: args.agents },
        notice: "effectsChanged",
      }))
      return
    }
    case "state_changed": {
      const stateSha256 = outcome.state_sha256
      updateHarnessDialog(slots, id, "skillInstall", (prev) =>
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
      updateHarnessDialog(slots, id, "skillInstall", (prev) => ({
        ...prev,
        step: "result",
        result: outcome,
      }))
  }
}

/**
 * Back to the input from a later step. After the catalog's account changed,
 * the plan is asked for again: its blocking reasons and warnings were made
 * from the old account, and the input must not show one thing while the
 * next call confirms another.
 */
export function backToSkillInput(slots: HarnessSlotStore, id: number): void {
  const dialog = skillDialogOf(slots, id, "skillInstall")
  if (!dialog || dialog.step === "installing") return
  if (dialog.restate) {
    void planSkillInstall(slots, id, { agents: dialog.input?.agents })
    return
  }
  updateHarnessDialog(slots, id, "skillInstall", (prev) => ({
    ...prev,
    step: "input",
  }))
}

/** Accept (or not) the withdrawn version — in the input or after the
 *  catalog's account changed. */
export function setSkillAcceptYanked(
  slots: HarnessSlotStore,
  id: number,
  accept: boolean
): void {
  updateHarnessDialog(slots, id, "skillInstall", (prev) =>
    prev.input && (prev.step === "input" || prev.step === "stateChanged")
      ? { ...prev, input: { ...prev.input, acceptYanked: accept } }
      : prev
  )
}

/**
 * `openHarness({ section: "discover", itemRef, intent: "install" })`: show
 * the item, and once it is in, offer its install dialog — an MCP server's or
 * a skill's. Any other kind has nothing to install. Nothing is installed:
 * the dialog asks.
 */
export async function openDiscoverItemToInstallAny(
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
    !detail.item
  ) {
    return
  }
  const kind = knownKind(detail.item.kind)
  if (kind === "mcp") {
    openMcpInstall(slots, {
      itemRef: detail.item.ref,
      title: detail.item.title,
      purpose: "install",
      from: "discover",
    })
  } else if (kind === "skill") {
    openSkillInstall(slots, {
      itemRef: detail.item.ref,
      title: detail.item.title,
      purpose: "install",
      from: "discover",
    })
  }
}

// ─── Uninstall ────────────────────────────────────────────────────────

/** Open the uninstall dialog for an installed skill, and ask the backend at
 *  once what uninstalling it would do. */
export function openSkillUninstall(
  slots: HarnessSlotStore,
  skill: { itemId: string; itemRef: string; name: string }
): number | null {
  if (isHarnessDialogWriting(slots)) return null
  const id = nextHarnessDialogId()
  slots.set(MCP_HARNESS_DIALOG, {
    kind: "skillUninstall",
    id,
    itemId: skill.itemId,
    itemRef: skill.itemRef,
    name: skill.name,
    phase: "checking",
    preflight: null,
    result: null,
    failure: null,
    notice: null,
    request: 0,
  })
  void preflightSkillUninstall(slots, id)
  return id
}

/** Ask what uninstalling would do. Writes nothing. */
export async function preflightSkillUninstall(
  slots: HarnessSlotStore,
  id: number
): Promise<void> {
  const dialog = skillDialogOf(slots, id, "skillUninstall")
  if (!dialog || dialog.phase === "uninstalling") return
  const request = newRequest()
  updateHarnessDialog(slots, id, "skillUninstall", (prev) => ({
    ...prev,
    phase: "checking",
    failure: null,
    request,
  }))
  const current = () =>
    skillDialogOf(slots, id, "skillUninstall")?.request === request
  try {
    const preflight = await harnessSkillUninstall({
      itemId: dialog.itemId,
      preflight: true,
    })
    if (!current()) return
    updateHarnessDialog(slots, id, "skillUninstall", (prev) => ({
      ...prev,
      phase: "ready",
      preflight,
      result: null,
    }))
  } catch (error) {
    if (!current()) return
    updateHarnessDialog(slots, id, "skillUninstall", (prev) => ({
      ...prev,
      phase: "ready",
      preflight: null,
      failure: harnessFailureOf(error),
    }))
  }
}

/** Whether the uninstall may go now: the account on show is a preflight
 *  with nothing in the way, and it has the `ack` that stands for it. */
export function canConfirmSkillUninstall(
  dialog: SkillUninstallDialog
): boolean {
  const step =
    dialog.phase === "ready" ||
    (dialog.phase === "result" && dialog.result?.outcome === "busy")
  const preflight = dialog.preflight
  return (
    step &&
    preflight !== null &&
    preflight.outcome === "preflight" &&
    preflight.ack !== null
  )
}

/** Uninstall what the preflight showed, with its `ack`. If what it would do
 *  changed since, nothing is written, and the new account is shown to be
 *  confirmed again. */
export async function confirmSkillUninstall(
  slots: HarnessSlotStore,
  id: number
): Promise<void> {
  const dialog = skillDialogOf(slots, id, "skillUninstall")
  if (!dialog || !canConfirmSkillUninstall(dialog) || !dialog.preflight) return
  const ack = dialog.preflight.ack
  const request = newRequest()
  updateHarnessDialog(slots, id, "skillUninstall", (prev) => ({
    ...prev,
    phase: "uninstalling",
    failure: null,
    notice: null,
    request,
  }))
  let result: HarnessSkillUninstallResult | null = null
  let failure: HarnessFailure | null = null
  try {
    result = await harnessSkillUninstall({ itemId: dialog.itemId, ack })
  } catch (error) {
    failure = harnessFailureOf(error)
  }
  if (
    result?.outcome === "uninstalled" ||
    result?.outcome === "write_failed" ||
    result?.outcome === "refused"
  ) {
    void reloadHarnessInstalled(slots)
  }
  if (skillDialogOf(slots, id, "skillUninstall")?.request !== request) return
  if (!result) {
    updateHarnessDialog(slots, id, "skillUninstall", (prev) => ({
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
    updateHarnessDialog(slots, id, "skillUninstall", (prev) => ({
      ...prev,
      phase: "ready",
      preflight: outcome.ack ? { ...outcome, outcome: "preflight" } : null,
      notice: "effectsChanged",
    }))
    if (!outcome.ack) void preflightSkillUninstall(slots, id)
    return
  }
  updateHarnessDialog(slots, id, "skillUninstall", (prev) => ({
    ...prev,
    phase: "result",
    result: outcome,
  }))
}
