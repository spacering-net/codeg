/**
 * The commands that install MCP servers from Harness, and the event that
 * says what is installed changed.
 *
 * Like the browse commands (`./api.ts`), each goes through the window's
 * transport, so it acts on whatever host that reaches: this computer, a
 * remote workspace's host, or the server behind a browser — the host whose
 * agents the servers are written to, and whose Codeg asks the catalog.
 *
 * Everything an install can come to — refused, a file changed elsewhere, the
 * catalog's account changed, a lock that was busy — is in the result. A
 * promise rejects only when the request never got that far: the catalog
 * switched off or out of reach, an older Codeg without the command, an
 * answer that cannot be read (see `./errors.ts`).
 */
import { getTransport, type UnsubscribeFn } from "@/lib/transport"
import { HarnessClientError } from "./errors"
import { isItemRef } from "./item-ref"
import {
  normalizeInstalled,
  normalizeInstalledChanged,
  normalizeMcpInstallResult,
  normalizeMcpPlan,
  normalizeMcpUninstallResult,
} from "./mcp-install-normalize"
import {
  HARNESS_INSTALLED_CHANGED_EVENT,
  type HarnessInstalled,
  type HarnessInstalledChanged,
  type HarnessMcpInstallArgs,
  type HarnessMcpInstallResult,
  type HarnessMcpPlan,
  type HarnessMcpUninstallArgs,
  type HarnessMcpUninstallResult,
} from "./mcp-install-types"

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
 * Everything the install dialog shows, in one answer: the item, the
 * version's state read fresh from the catalog, the ways to run it, the name
 * it would go under and who already uses that name, and every agent. Writes
 * nothing. Without `revision`, the newest.
 */
export async function harnessMcpPlan(
  itemRef: string,
  revision?: number | null
): Promise<HarnessMcpPlan> {
  return normalizeMcpPlan(
    await getTransport().call("harness_mcp_plan", {
      itemRef: checkedRef(itemRef),
      revision: revision ?? null,
    })
  )
}

/**
 * Install (or update) what the user confirmed — exactly as the dialog showed
 * it: the plan's revision and fingerprint, and each target's basis. Codeg
 * checks it all again before it writes; whatever stops it is in the result.
 */
export async function harnessMcpInstall(
  args: HarnessMcpInstallArgs
): Promise<HarnessMcpInstallResult> {
  return normalizeMcpInstallResult(
    await getTransport().call("harness_mcp_install", {
      ...args,
      itemRef: checkedRef(args.itemRef),
    })
  )
}

/** What is installed from Harness on this host, checked against the agents'
 *  files now. Needs no catalog. */
export async function harnessInstalled(): Promise<HarnessInstalled> {
  return normalizeInstalled(await getTransport().call("harness_installed"))
}

/** Remove an installed item from its agents — or, with `preflight`, only say
 *  what that would do. Needs no catalog. */
export async function harnessMcpUninstall(
  args: HarnessMcpUninstallArgs
): Promise<HarnessMcpUninstallResult> {
  return normalizeMcpUninstallResult(
    await getTransport().call("harness_mcp_uninstall", {
      itemId: args.itemId,
      agents: args.agents ?? null,
      removeChanged: args.removeChanged ?? [],
      basis: args.basis ?? {},
      preflight: args.preflight ?? false,
    })
  )
}

/**
 * `harness://installed-changed`: an install, an update, an uninstall, or a
 * listing that found an agent's entry gone. The answer to it is a fresh
 * `harness_installed`. Rejects (rather than throws) where the transport has
 * no events.
 */
export async function onHarnessInstalledChanged(
  handler: (payload: HarnessInstalledChanged) => void
): Promise<UnsubscribeFn> {
  return getTransport().subscribe<unknown>(
    HARNESS_INSTALLED_CHANGED_EVENT,
    (payload) => handler(normalizeInstalledChanged(payload))
  )
}
