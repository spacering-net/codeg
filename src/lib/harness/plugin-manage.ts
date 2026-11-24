/**
 * Managing an installed plugin as a whole — updating it, giving one agent
 * another mode, switching it off or on for one agent, repairing it,
 * uninstalling it: the decisions of those dialogs, as pure functions of what
 * the backend showed and what the user put in.
 *
 * The install dialog's rules hold (`plugin-install.ts`): what is sent is what
 * was shown — every ack is the preview's, the fingerprint the plan's — and
 * the agreement to what runs on its own counts only for the `exec_sha256` it
 * was given for. Each of these commands is asked first with `preflight` (or
 * planned), and the real call carries exactly that answer's acks.
 */
import type { AgentType } from "@/lib/types"
import type {
  HarnessPluginInstallResult,
  HarnessPluginRepairArgs,
  HarnessPluginRevision,
  HarnessPluginSetEnabledArgs,
  HarnessPluginSetHostArgs,
  HarnessPluginSkillsPlan,
  HarnessPluginUpdateArgs,
  HarnessPluginUpdateHost,
  HarnessPluginUpdatePlan,
  PluginMode,
} from "./plugin-install-types"

/** A links preview's acks, by member: each op's, as the engine made it. */
export function skillsPlanAcks(
  plan: HarnessPluginSkillsPlan | null | undefined
): Record<string, string> {
  const acks: Record<string, string> = {}
  for (const op of plan?.links?.ops ?? []) {
    if (op.ack) acks[op.skill] = op.ack
  }
  return acks
}

/** What stands in the way of one agent's links, by its preview: a name held,
 *  an op blocked, an issue — or no preview that can be read. */
export function skillsPlanProblemOf(
  plan: HarnessPluginSkillsPlan | null
): "blocked" | "noPreview" | null {
  if (!plan) return null
  if (!plan.links) return "noPreview"
  if (
    plan.issues.length > 0 ||
    plan.held.length > 0 ||
    plan.links.ops.some((op) => op.status === "blocked")
  ) {
    return "blocked"
  }
  return null
}

// ─── Update ───────────────────────────────────────────────────────────

export interface PluginUpdateInput {
  /** The `exec_sha256` agreed to; counts only while it is the plan's. */
  consentExec: string | null
  acceptYanked: boolean
}

export const EMPTY_UPDATE_INPUT: PluginUpdateInput = {
  consentExec: null,
  acceptYanked: false,
}

/** The revision the update goes to, as the plan describes it. */
export function updateTargetOf(
  plan: HarnessPluginUpdatePlan
): HarnessPluginRevision | null {
  if (plan.target === null) return null
  if (plan.full?.revision === plan.target) return plan.full
  if (plan.latest?.revision === plan.target) return plan.latest
  return null
}

export function needsUpdateYankedConfirm(
  plan: HarnessPluginUpdatePlan
): boolean {
  const target = updateTargetOf(plan)
  return (
    (target?.confirm.some((reason) => reason.code === "yanked") ?? false) ||
    plan.snapshot?.status === "yanked"
  )
}

export function updateConsentGiven(
  plan: HarnessPluginUpdatePlan,
  input: PluginUpdateInput
): boolean {
  return plan.consent_exec !== null && input.consentExec === plan.consent_exec
}

export type PluginUpdateBlocker =
  /** Every agent already has the target as it should. */
  | { kind: "upToDate" }
  /** The plan says it cannot be updated so (`plan.blocking`). */
  | { kind: "item" }
  /** There is no revision to move to. */
  | { kind: "target" }
  /** The catalog gave no fingerprint of the target. */
  | { kind: "state" }
  | { kind: "consent" }
  | { kind: "yanked" }
  | { kind: "agent"; agent: AgentType; problem: "blocked" | "noPreview" }

export function pluginUpdateBlockersOf(
  plan: HarnessPluginUpdatePlan,
  input: PluginUpdateInput
): PluginUpdateBlocker[] {
  const blockers: PluginUpdateBlocker[] = []
  if (plan.up_to_date) blockers.push({ kind: "upToDate" })
  if (plan.blocking.length > 0) blockers.push({ kind: "item" })
  if (plan.target === null) blockers.push({ kind: "target" })
  if (!plan.state_sha256) blockers.push({ kind: "state" })
  if (plan.needs_consent && !updateConsentGiven(plan, input)) {
    blockers.push({ kind: "consent" })
  }
  if (needsUpdateYankedConfirm(plan) && !input.acceptYanked) {
    blockers.push({ kind: "yanked" })
  }
  for (const host of plan.hosts) {
    const problem = skillsPlanProblemOf(host.skills)
    if (problem) blockers.push({ kind: "agent", agent: host.agent, problem })
  }
  return blockers
}

function updateAcksOf(
  hosts: readonly HarnessPluginUpdateHost[]
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  for (const host of hosts) {
    const acks = skillsPlanAcks(host.skills)
    if (Object.keys(acks).length > 0) out[host.agent] = acks
  }
  return out
}

function updateExpertsAcksOf(
  hosts: readonly HarnessPluginUpdateHost[]
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const host of hosts) {
    if (host.experts_ack) out[host.agent] = host.experts_ack
  }
  return out
}

/**
 * The one update call the dialog makes — or `null` while anything is still
 * open: the plan's target and fingerprint, the agreement only where the plan
 * asks for it, every ack of what the plan showed, and `acceptYanked` only
 * where it was asked and ticked.
 */
export function pluginUpdateArgsOf(
  itemId: string,
  plan: HarnessPluginUpdatePlan,
  input: PluginUpdateInput
): HarnessPluginUpdateArgs | null {
  if (pluginUpdateBlockersOf(plan, input).length > 0) return null
  if (plan.target === null || !plan.state_sha256) return null
  return {
    itemId,
    revision: plan.target,
    stateSha256: plan.state_sha256,
    consentExec: plan.needs_consent ? plan.consent_exec : null,
    acks: updateAcksOf(plan.hosts),
    expertsAcks: updateExpertsAcksOf(plan.hosts),
    acceptYanked: needsUpdateYankedConfirm(plan) && input.acceptYanked,
  }
}

// ─── A change for one agent, and repair ───────────────────────────────

/** What a change dialog was opened for. */
export type PluginChangeAction =
  | { kind: "mode"; agent: AgentType; mode: PluginMode }
  | { kind: "enabled"; agent: AgentType; enabled: boolean }
  /** `agent: null`: every agent that needs it. */
  | { kind: "repair"; agent: AgentType | null }

export interface PluginChangeInput {
  consentExec: string | null
}

export type PluginChangeBlocker =
  /** The preflight came back refused: nothing can be done so. */
  | { kind: "refused" }
  /** Installing whole needs the catalog's fingerprint of the revision. */
  | { kind: "state" }
  | { kind: "consent" }

export function changeConsentGiven(
  preflight: HarnessPluginInstallResult,
  input: PluginChangeInput
): boolean {
  return (
    preflight.consent_exec !== null &&
    input.consentExec === preflight.consent_exec
  )
}

export function pluginChangeBlockersOf(
  action: PluginChangeAction,
  preflight: HarnessPluginInstallResult,
  input: PluginChangeInput
): PluginChangeBlocker[] {
  const blockers: PluginChangeBlocker[] = []
  if (preflight.outcome !== "preflight") blockers.push({ kind: "refused" })
  if (
    action.kind === "mode" &&
    action.mode === "native" &&
    !preflight.state_sha256
  ) {
    blockers.push({ kind: "state" })
  }
  if (preflight.consent_required && !changeConsentGiven(preflight, input)) {
    blockers.push({ kind: "consent" })
  }
  return blockers
}

/** The call a change makes: the preflight's (`preflight: true`), or — with
 *  its answer — the real one, carrying that answer's acks. */
export type PluginChangeCall =
  | { command: "set_host"; args: HarnessPluginSetHostArgs }
  | { command: "set_enabled"; args: HarnessPluginSetEnabledArgs }
  | { command: "repair"; args: HarnessPluginRepairArgs }

export function pluginChangePreflightOf(
  itemId: string,
  action: PluginChangeAction
): PluginChangeCall {
  switch (action.kind) {
    case "mode":
      return {
        command: "set_host",
        args: {
          itemId,
          agent: action.agent,
          mode: action.mode,
          preflight: true,
          stateSha256: null,
          consentExec: null,
          acks: {},
          expertsAck: null,
        },
      }
    case "enabled":
      return {
        command: "set_enabled",
        args: {
          itemId,
          agent: action.agent,
          enabled: action.enabled,
          preflight: true,
          acks: {},
          expertsAck: null,
        },
      }
    case "repair":
      return {
        command: "repair",
        args: {
          itemId,
          agent: action.agent,
          preflight: true,
          acks: {},
          expertsAcks: {},
        },
      }
  }
}

/** The real call, from the preflight on show — or `null` while anything
 *  stands in the way. */
export function pluginChangeCallOf(
  itemId: string,
  action: PluginChangeAction,
  preflight: HarnessPluginInstallResult,
  input: PluginChangeInput
): PluginChangeCall | null {
  if (pluginChangeBlockersOf(action, preflight, input).length > 0) return null
  const consentExec = preflight.consent_required ? preflight.consent_exec : null
  switch (action.kind) {
    case "mode":
      return {
        command: "set_host",
        args: {
          itemId,
          agent: action.agent,
          mode: action.mode,
          preflight: false,
          stateSha256: preflight.state_sha256,
          consentExec,
          acks: skillsPlanAcks(preflight.skills[action.agent]),
          expertsAck: preflight.experts_acks[action.agent] ?? null,
        },
      }
    case "enabled":
      return {
        command: "set_enabled",
        args: {
          itemId,
          agent: action.agent,
          enabled: action.enabled,
          preflight: false,
          acks: skillsPlanAcks(preflight.skills[action.agent]),
          expertsAck: preflight.experts_acks[action.agent] ?? null,
        },
      }
    case "repair": {
      const acks: Record<string, Record<string, string>> = {}
      for (const [agent, plan] of Object.entries(preflight.skills)) {
        const byMember = skillsPlanAcks(plan)
        if (Object.keys(byMember).length > 0) acks[agent] = byMember
      }
      return {
        command: "repair",
        args: {
          itemId,
          agent: action.agent,
          preflight: false,
          acks,
          expertsAcks: { ...preflight.experts_acks },
        },
      }
    }
  }
}
