/**
 * The commands that install, update and uninstall skills from Harness.
 *
 * Each goes through the window's transport, so it acts on whatever host that
 * reaches: this computer, a remote workspace's host, or the server behind a
 * browser — the host whose skill store and agents the skill goes to, and
 * whose Codeg downloads it.
 *
 * Everything an install can come to — refused, a link that now reaches other
 * agents, the catalog's account changed, a package that is not what it says,
 * a busy lock — is in the result. A promise rejects only when the request
 * never got that far: the catalog switched off or out of reach, an older
 * Codeg without the command, an answer that cannot be read.
 *
 * The listing (`harness_installed`) and its event are the MCP step's
 * (`mcp-install-api.ts`): one command lists both parts.
 */
import { getTransport } from "@/lib/transport"
import type { AgentType } from "@/lib/types"
import { HarnessClientError } from "./errors"
import { isItemRef } from "./item-ref"
import {
  normalizeSkillInstallResult,
  normalizeSkillPlan,
  normalizeSkillUninstallResult,
} from "./skill-install-normalize"
import type {
  HarnessSkillInstallArgs,
  HarnessSkillInstallResult,
  HarnessSkillPlan,
  HarnessSkillUninstallResult,
} from "./skill-install-types"

function checkedRef(itemRef: string): string {
  if (!isItemRef(itemRef)) {
    throw new HarnessClientError(
      "invalidRef",
      `Not a Harness address: ${itemRef}`
    )
  }
  return itemRef
}

/**
 * Everything the dialog shows, in one answer: the item, the version's state
 * read fresh from the catalog, what the package holds, the name it would go
 * under and why, every agent, and what linking it to `agents` (or to the
 * plan's own choice) would do. Writes nothing. Without `revision`, the
 * newest.
 */
export async function harnessSkillPlan(
  itemRef: string,
  revision?: number | null,
  agents?: readonly AgentType[] | null
): Promise<HarnessSkillPlan> {
  return normalizeSkillPlan(
    await getTransport().call("harness_skill_plan", {
      itemRef: checkedRef(itemRef),
      revision: revision ?? null,
      agents: agents ? [...agents] : null,
    })
  )
}

/**
 * Install (or update) what the user confirmed — exactly as the dialog showed
 * it: the plan's revision and fingerprint, the name, the agents, the acks of
 * the links it showed. Codeg checks it all again before and while it writes.
 */
export async function harnessSkillInstall(
  args: HarnessSkillInstallArgs
): Promise<HarnessSkillInstallResult> {
  return normalizeSkillInstallResult(
    await getTransport().call("harness_skill_install", {
      ...args,
      itemRef: checkedRef(args.itemRef),
    })
  )
}

/** Uninstall a skill installed from Harness — or, with `preflight`, only say
 *  what that would do. The real call carries the preflight's `ack`. Needs no
 *  catalog. */
export async function harnessSkillUninstall(args: {
  itemId: string
  preflight?: boolean
  ack?: string | null
}): Promise<HarnessSkillUninstallResult> {
  return normalizeSkillUninstallResult(
    await getTransport().call("harness_skill_uninstall", {
      itemId: args.itemId,
      preflight: args.preflight ?? false,
      ack: args.ack ?? null,
    })
  )
}
