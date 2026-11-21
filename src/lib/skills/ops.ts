/**
 * The ops the page asks the engine for, and what its answers come to.
 *
 * Two rules hold throughout, both the engine's own (`skills_apply_links`):
 *
 * - **All or none.** A request with one op that cannot be done, or that needs
 *   an acknowledgement it was not sent, writes nothing at all.
 * - **The ack is the preflight's.** An op whose effects reach another agent
 *   goes through only with the `ack` its preflight returned, which stands for
 *   exactly the effects the user was shown. The page never makes one up.
 */
import type { AgentType } from "@/lib/types"
import { cellView, type SkillsModel } from "./model"
import type {
  SkillEffects,
  SkillOp,
  SkillOpResult,
  SkillsApplyResult,
} from "./types"

export interface CellTarget {
  skill: string
  agent: AgentType
}

/**
 * The fewest ops that move `targets` on (or off). A cell already where it is
 * asked to be is skipped, and so is one that cannot be switched — something
 * else holds the name, the agent has nowhere to link to, the skill is not
 * ready (`ready`) — or, turning off, a copy changed on the agent's side,
 * which the engine never takes away. An empty answer means nothing to do: the
 * caller sends nothing.
 */
export function deltaOps(
  model: SkillsModel,
  targets: readonly CellTarget[],
  enable: boolean,
  ready: (skillId: string) => boolean = () => true
): SkillOp[] {
  const ops: SkillOp[] = []
  const seen = new Set<string>()
  for (const { skill, agent } of targets) {
    const key = `${skill}\u0000${agent}`
    if (seen.has(key)) continue
    seen.add(key)
    const view = cellView(
      model.cell(skill, agent),
      model.agent(agent),
      ready(skill)
    )
    if (enable ? view.toggle !== "enable" : view.toggle !== "disable") continue
    ops.push({ skill, agent, action: enable ? "enable" : "disable" })
  }
  return ops
}

/** Whether any op may reach another agent, so that it has to be planned
 *  first. A request the page is unsure of is planned too: doing so is
 *  harmless, a missing confirmation is not. */
export function needsPlanning(model: SkillsModel, ops: readonly SkillOp[]) {
  return ops.some((op) => {
    if (op.action !== "enable" && op.action !== "disable") return true
    const view = cellView(model.cell(op.skill, op.agent), model.agent(op.agent))
    return view.check || view.toggle !== op.action
  })
}

/** `ops` with the acks a preflight returned, op by op. An op the preflight
 *  gave none goes without. */
export function opsWithAcks(
  ops: readonly SkillOp[],
  preflight: SkillsApplyResult
): SkillOp[] {
  return ops.map((op, index) => {
    const planned = preflight.ops.find((result) => result.index === index)
    const next: SkillOp = {
      skill: op.skill,
      agent: op.agent,
      action: op.action,
    }
    if (op.replace_modified) next.replace_modified = true
    if (planned?.ack) next.ack = planned.ack
    return next
  })
}

/** "Saved" is said only for this: every op done. */
export function isApplied(result: SkillsApplyResult): boolean {
  return result.ok && result.outcome === "applied"
}

/** The effects reach an agent other than the one acted on. */
export function reachesOthers(effects: SkillEffects): boolean {
  return (
    effects.gains.length > 0 ||
    effects.loses.length > 0 ||
    effects.touches.length > 0
  )
}

/** Whether a plan has to be shown before it is carried out: an op needs an
 *  acknowledgement, one is blocked, or the request itself is in trouble. */
export function mustReview(preflight: SkillsApplyResult): boolean {
  if (preflight.outcome !== "preflight" || !preflight.ok) return true
  return preflight.ops.some(
    (op) => op.status === "needs_ack" || op.ack !== null || reachesOthers(op)
  )
}

/** The ops of a result that did something or stopped something — what a
 *  review or a result is about. `unchanged` ops with nothing to say are
 *  left out. */
export function notableOps(result: SkillsApplyResult): SkillOpResult[] {
  return result.ops.filter(
    (op) =>
      op.status !== "unchanged" ||
      op.warnings.length > 0 ||
      op.issues.length > 0
  )
}

/** The agents an op touches, itself included. */
export function affectedAgents(effects: SkillEffects, agent?: AgentType) {
  return [
    ...new Set([
      ...(agent ? [agent] : []),
      ...effects.gains,
      ...effects.loses,
      ...effects.touches,
    ]),
  ]
}

/** The store skills a set of ops names. */
export function skillsOf(ops: readonly { skill: string }[]): string[] {
  return [...new Set(ops.map((op) => op.skill))]
}
