/**
 * The commands that install and uninstall plugins from Harness (a plugin's
 * releases are a browse command: `./api.ts`).
 *
 * Each goes through the window's transport (`getTransport`), so it acts on
 * whatever host that reaches — this computer, a remote workspace's host, or
 * the server behind a browser: the host whose agents and plugin store the
 * plugin goes to. As with the skill install's (`skill-install-api.ts`),
 * everything an install can come to is in the result; a promise rejects only
 * when the request never got that far.
 */
import { getTransport } from "@/lib/transport"
import type { AgentType } from "@/lib/types"
import { HarnessClientError } from "./errors"
import { isItemRef } from "./item-ref"
import {
  normalizeHookTrust,
  normalizePluginInstallResult,
  normalizePluginPlan,
  normalizePluginUninstallResult,
  normalizePluginUpdatePlan,
} from "./plugin-install-normalize"
import type {
  HarnessHookTrust,
  HarnessPluginInstallArgs,
  HarnessPluginInstallResult,
  HarnessPluginPlan,
  HarnessPluginRepairArgs,
  HarnessPluginSetEnabledArgs,
  HarnessPluginSetHostArgs,
  HarnessPluginUninstallResult,
  HarnessPluginUpdateArgs,
  HarnessPluginUpdatePlan,
  PluginMode,
} from "./plugin-install-types"

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
 * Everything the dialog shows, in one answer: the latest revision and the
 * one to install whole, one row per agent (`agents`, else every agent
 * installed here) with what its host can take, and — for `modes` (else each
 * row's default) — the revision those modes install, what must be agreed to,
 * and each skills row's link preview. Writes nothing.
 */
export async function harnessPluginPlan(
  itemRef: string,
  options: {
    agents?: readonly AgentType[] | null
    modes?: Readonly<Record<string, PluginMode>> | null
  } = {}
): Promise<HarnessPluginPlan> {
  return normalizePluginPlan(
    await getTransport().call("harness_plugin_plan", {
      itemRef: checkedRef(itemRef),
      agents: options.agents ? [...options.agents] : null,
      modes: options.modes ? { ...options.modes } : null,
    })
  )
}

/** Install what the user confirmed, exactly as the dialog showed it. Codeg
 *  checks it all again before and while it writes. */
export async function harnessPluginInstall(
  args: HarnessPluginInstallArgs
): Promise<HarnessPluginInstallResult> {
  return normalizePluginInstallResult(
    await getTransport().call("harness_plugin_install", {
      ...args,
      itemRef: checkedRef(args.itemRef),
    })
  )
}

/** Uninstall a plugin — or, with `preflight`, only say what that would do.
 *  The real call carries the preflight's `ack`. Needs no catalog. */
export async function harnessPluginUninstall(args: {
  itemId: string
  preflight?: boolean
  ack?: string | null
}): Promise<HarnessPluginUninstallResult> {
  return normalizePluginUninstallResult(
    await getTransport().call("harness_plugin_uninstall", {
      itemId: args.itemId,
      preflight: args.preflight ?? false,
      ack: args.ack ?? null,
    })
  )
}

/** What updating an installed plugin would do: from which revision to which,
 *  the members that changed, each agent's row, what must be agreed to.
 *  Writes nothing. */
export async function harnessPluginPlanUpdate(
  itemId: string
): Promise<HarnessPluginUpdatePlan> {
  return normalizePluginUpdatePlan(
    await getTransport().call("harness_plugin_plan_update", { itemId })
  )
}

/** Update what the dialog showed. Answers as an install does. */
export async function harnessPluginUpdate(
  args: HarnessPluginUpdateArgs
): Promise<HarnessPluginInstallResult> {
  return normalizePluginInstallResult(
    await getTransport().call("harness_plugin_update", { ...args })
  )
}

/** Give one agent another mode (or none) — with `preflight`, only say what
 *  that would do. */
export async function harnessPluginSetHost(
  args: HarnessPluginSetHostArgs
): Promise<HarnessPluginInstallResult> {
  return normalizePluginInstallResult(
    await getTransport().call("harness_plugin_set_host", { ...args })
  )
}

/** Switch one agent's plugin off, or on again. */
export async function harnessPluginSetEnabled(
  args: HarnessPluginSetEnabledArgs
): Promise<HarnessPluginInstallResult> {
  return normalizePluginInstallResult(
    await getTransport().call("harness_plugin_set_enabled", { ...args })
  )
}

/** Bring the agents an interrupted operation left back to the record. */
export async function harnessPluginRepair(
  args: HarnessPluginRepairArgs
): Promise<HarnessPluginInstallResult> {
  return normalizePluginInstallResult(
    await getTransport().call("harness_plugin_repair", { ...args })
  )
}

/** Codex's own trust of the plugin's hooks for one agent — asked of Codex,
 *  only when the user asks. */
export async function harnessPluginHookTrust(
  itemId: string,
  agent: AgentType
): Promise<HarnessHookTrust> {
  return normalizeHookTrust(
    await getTransport().call("harness_plugin_hook_trust", { itemId, agent })
  )
}
