/**
 * The skills engine's commands and its event.
 *
 * Everything goes through the window's transport, so it reads and writes the
 * skills of whatever host that transport reaches: this computer, a remote
 * workspace's host, or the server behind a browser.
 *
 * The seven commands answer every outcome in their result — a busy lock, an
 * op that needs confirming, a write that failed — and reject only when the
 * request never reached the engine (see `./errors.ts`). Callers check
 * `outcome` and `ok`, never rely on a throw.
 */
import { getTransport, type UnsubscribeFn } from "@/lib/transport"
import {
  normalizeAdoptResult,
  normalizeApplyResult,
  normalizeBackupResult,
  normalizeBackups,
  normalizeChanged,
  normalizeDeleteResult,
  normalizeInventory,
  normalizeRepairResult,
} from "./normalize"
import type { AgentSkillScope, AgentType } from "@/lib/types"
import {
  SKILLS_CHANGED_EVENT,
  type SkillPageDeleteResult,
  type SkillsAdoptArgs,
  type SkillsAdoptResult,
  type SkillsApplyArgs,
  type SkillsApplyResult,
  type SkillsBackupResult,
  type SkillsBackups,
  type SkillsChanged,
  type SkillsInventory,
  type SkillsRepairArgs,
  type SkillsRepairResult,
} from "./types"

/** Every store skill and every agent's skill directories, read afresh.
 *  Writes nothing, takes no lock. */
export async function skillsInventory(): Promise<SkillsInventory> {
  return normalizeInventory(await getTransport().call("skills_inventory"))
}

/**
 * Carry out `ops` — all of them or none — or, with `preflight`, only plan
 * them. An op whose effects reach another agent goes through only with the
 * `ack` its preflight returned.
 */
export async function skillsApplyLinks(
  params: SkillsApplyArgs
): Promise<SkillsApplyResult> {
  return normalizeApplyResult(
    await getTransport().call("skills_apply_links", {
      ops: params.ops,
      preflight: params.preflight ?? false,
    })
  )
}

/** Re-point a broken link Codeg made at the store's skill of its own name,
 *  or take it away. */
export async function skillsRepairLink(
  params: SkillsRepairArgs
): Promise<SkillsRepairResult> {
  return normalizeRepairResult(
    await getTransport().call("skills_repair_link", {
      path: params.path,
      action: params.action,
      preflight: params.preflight ?? false,
      ack: params.ack ?? null,
    })
  )
}

/** Move one of an agent's own skills into Codeg's store, as a Custom skill,
 *  and link it back where it was. */
export async function skillsAdopt(
  params: SkillsAdoptArgs
): Promise<SkillsAdoptResult> {
  return normalizeAdoptResult(
    await getTransport().call("skills_adopt", {
      agent: params.agent,
      skill: params.skill,
      dir: params.dir ?? null,
    })
  )
}

/** The backups of one skill — or, without one, of every skill. */
export async function skillsBackups(skill?: string): Promise<SkillsBackups> {
  return normalizeBackups(
    await getTransport().call("skills_backups", { skill: skill ?? null })
  )
}

/** Make a backup the Custom skill `id`. */
export async function skillsBackupRestore(params: {
  skill: string
  name: string
  id: string
}): Promise<SkillsBackupResult> {
  return normalizeBackupResult(
    await getTransport().call("skills_backup_restore", {
      skill: params.skill,
      name: params.name,
      id: params.id,
    })
  )
}

export async function skillsBackupDelete(params: {
  skill: string
  name: string
}): Promise<SkillsBackupResult> {
  return normalizeBackupResult(
    await getTransport().call("skills_backup_delete", {
      skill: params.skill,
      name: params.name,
    })
  )
}

/**
 * Delete one of an agent's skills — the Skills page's command, which throws
 * its refusals rather than answering them. With `preflight` it deletes
 * nothing and says what would go, and which other agents read that folder;
 * a real delete there needs the preflight's `ack` (refused with
 * `acknowledgement_required` / `effects_changed` otherwise). In a folder of
 * the agent's own no ack is needed.
 */
export async function skillPageDelete(params: {
  agent: AgentType
  scope: AgentSkillScope
  skillId: string
  workspacePath: string | null
  preflight: boolean
  ack?: string | null
}): Promise<SkillPageDeleteResult> {
  return normalizeDeleteResult(
    await getTransport().call("acp_delete_agent_skill", {
      agentType: params.agent,
      scope: params.scope,
      skillId: params.skillId,
      workspacePath: params.workspacePath,
      preflight: params.preflight,
      ack: params.ack ?? null,
    })
  )
}

/**
 * `skills://changed`: Codeg changed a skill or a link — this window, another
 * one, or another client of the same server. It names kinds and agents,
 * nothing else; the answer to it is a fresh read. It is NOT sent when an
 * agent or the user changes a skills folder by hand.
 */
export function onSkillsChanged(
  handler: (payload: SkillsChanged) => void
): Promise<UnsubscribeFn> {
  return getTransport().subscribe<unknown>(SKILLS_CHANGED_EVENT, (payload) =>
    handler(normalizeChanged(payload))
  )
}
