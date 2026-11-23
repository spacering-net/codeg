/**
 * The installed plugins, as the Plugins section and everything that asks
 * "does a plugin give this agent that skill" read them — pure functions of
 * `harness_installed`'s `plugins` and the host's update check.
 *
 * A plugin is managed as a whole (docs/harness-plugins.md §7): one row per
 * plugin, each agent's mode and state on it, its members only to be seen.
 * Nothing here is more permissive than the listing: a state this build does
 * not know is "unknown", a mode it does not know gives no skill to anyone.
 */
import type { SkillsAgent } from "@/lib/skills/types"
import type { AgentType } from "@/lib/types"
import type { HarnessInstalled } from "./mcp-install-types"
import type {
  HarnessHookTrust,
  HarnessListedPlugin,
  HarnessListedPluginHost,
  HarnessPluginHostState,
} from "./plugin-install-types"
import {
  remoteFor,
  updatesById,
  type HarnessRemote,
  type HarnessUpdates,
} from "./updates"

// ─── One agent's state ────────────────────────────────────────────────

/** An agent's state on a plugin, in the section's words: on; switched off by
 *  the user; switched off by Codeg because SRN no longer vouches for the
 *  revision; left by an interrupted operation; or one this build does not
 *  know. */
export type PluginHostStateKey =
  | "active"
  | "disabled"
  | "suspended"
  | "needsRepair"
  | "unknown"

export function hostStateKey(
  state: HarnessPluginHostState
): PluginHostStateKey {
  switch (state.kind) {
    case "active":
      return "active"
    case "disabled_by_user":
      return "disabled"
    case "suspended":
      return "suspended"
    case "needs_repair":
      return "needsRepair"
    default:
      return "unknown"
  }
}

/** The mode an agent has the plugin in; `null` for one this build does not
 *  know (nothing is offered for it). */
export function hostModeOf(
  host: Pick<HarnessListedPluginHost, "mode">
): "native" | "skills" | null {
  if (host.mode === "native") return "native"
  if (host.mode === "skills") return "skills"
  return null
}

/** What the user may do with one agent's plugin, by its state: switch it off
 *  (on now), on again (switched off by the user), change its mode (on or off
 *  by the user). One Codeg switched off is turned on only by an update; one
 *  that needs repair, only by the repair. */
export function hostActionsOf(host: HarnessListedPluginHost): {
  disable: boolean
  enable: boolean
  changeMode: boolean
} {
  const state = hostStateKey(host.state)
  const known = hostModeOf(host) !== null
  return {
    disable: known && state === "active",
    enable: known && state === "disabled",
    changeMode: known && (state === "active" || state === "disabled"),
  }
}

/** The modes an agent's plugin may be changed to from the one it has: the
 *  other one, or none at all (taken off that agent). */
export function otherModesOf(
  host: HarnessListedPluginHost
): ("native" | "skills" | "none")[] {
  const mode = hostModeOf(host)
  if (!mode) return []
  return mode === "native" ? ["skills", "none"] : ["native", "none"]
}

// ─── One row ──────────────────────────────────────────────────────────

export interface PluginRow {
  plugin: HarnessListedPlugin
  /** What the update check says of the installed revision. */
  remote: HarnessRemote
  /** Some agent was left by an interrupted operation: "Repair" is offered. */
  needsRepair: boolean
  /** Codeg switched it off somewhere; only an update turns it on. */
  suspended: boolean
}

/** The rows, by install name. The update check's answer (read on its own,
 *  kept current by its events) goes first; the listing's own copy of it
 *  stands in until there is one. */
export function pluginRowsOf(
  plugins: readonly HarnessListedPlugin[],
  updates: HarnessUpdates | null
): PluginRow[] {
  const checked = updatesById(updates)
  return [...plugins]
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.item_id.localeCompare(b.item_id)
    )
    .map((plugin) => ({
      plugin,
      remote: remoteFor(
        checked.get(plugin.item_id) ??
          (updates?.enabled === false ? null : plugin.update),
        plugin.revision
      ),
      needsRepair: plugin.hosts.some(
        (host) => hostStateKey(host.state) === "needsRepair"
      ),
      suspended: plugin.hosts.some(
        (host) => hostStateKey(host.state) === "suspended"
      ),
    }))
}

/** The Plugins tab's count: the plugins installed; `undefined` until the
 *  host has said (or from a Codeg that does not list them). */
export function pluginSectionCount(
  installed: HarnessInstalled | null | undefined
): number | undefined {
  return installed?.plugins ? installed.plugins.length : undefined
}

/** The listing's row for an item, if it is an installed plugin. */
export function listedPluginOf(
  installed: HarnessInstalled | null | undefined,
  itemId: string
): HarnessListedPlugin | null {
  return installed?.plugins?.find((plugin) => plugin.item_id === itemId) ?? null
}

// ─── Codex's trust of the hooks ───────────────────────────────────────

/** What Codex's answer comes to, in a word: no hooks; every one trusted;
 *  one changed since it was trusted; one never trusted; or not known. */
export type HookTrustKey =
  | "none"
  | "trusted"
  | "modified"
  | "untrusted"
  | "unknown"

export function hookTrustKey(trust: HarnessHookTrust): HookTrustKey {
  if (trust.problem) return "unknown"
  if (trust.hooks.length === 0) return "none"
  const states = trust.hooks.map((hook) => hook.state)
  if (states.every((state) => state === "trusted")) return "trusted"
  if (states.includes("modified")) return "modified"
  if (states.includes("untrusted")) return "untrusted"
  return "unknown"
}

// ─── Which agent a plugin gives which skill ───────────────────────────

/** Hosts whose own plugin system puts a plugin's skills under the plugin's
 *  name (`superpowers:brainstorming`). Claude Code was seen to (P0, design
 *  §14). Codex: by its plugin loader (its skills loader namespaces plugin
 *  skills); not seen in a session yet. OpenCode's superpowers registers its
 *  skills by their own names. */
const NAMESPACING_HOSTS: ReadonlySet<string> = new Set(["claude", "codex"])

/**
 * The name an agent sees one of a plugin's skills under: `<plugin>:<skill>`
 * where its host installed the plugin whole and namespaces its skills (the
 * plugin's name as that host knows it); the skill's own name otherwise —
 * its skills only, or a host that does not namespace.
 */
export function pluginSkillInvocation(
  host: Pick<HarnessListedPluginHost, "mode" | "host_id" | "host_name">,
  installName: string,
  skill: string
): string {
  if (
    host.mode === "native" &&
    host.host_id !== null &&
    NAMESPACING_HOSTS.has(host.host_id)
  ) {
    return `${host.host_name ?? installName}:${skill}`
  }
  return skill
}

/** A plugin that gives an agent a skill. */
export interface PluginProvider {
  /** The plugin's install name. */
  plugin: string
  itemId: string
  mode: "native" | "skills"
  /** The agent has it on: on in the record and, installed whole, on in its
   *  host's own files with nothing amiss there (or not checked this time).
   *  (Its skills only: whether the link is really there is the skills
   *  inventory's to say.) */
  active: boolean
  /** The name the agent sees the skill under. */
  invocation: string
}

/** The skills a plugin gives one agent: whole, its skill members; its skills
 *  only, the ones that agent has (its members, should the listing not say). */
function skillsOf(
  plugin: HarnessListedPlugin,
  host: HarnessListedPluginHost
): string[] {
  const members = plugin.members
    .filter((member) => member.kind === "skill")
    .map((member) => member.name)
  if (host.mode === "skills" && host.skills.length > 0) return host.skills
  return members
}

/**
 * By agent, then by skill name: the plugin that gives it — in either mode,
 * in any state (a plugin switched off still holds the name: the Experts pack
 * must not be switched on under it). The first plugin listed keeps a name
 * two would give.
 */
export function pluginProvidersOf(
  plugins: readonly HarnessListedPlugin[]
): ReadonlyMap<AgentType, ReadonlyMap<string, PluginProvider>> {
  const out = new Map<AgentType, Map<string, PluginProvider>>()
  for (const plugin of plugins) {
    for (const host of plugin.hosts) {
      const mode = hostModeOf(host)
      if (!mode) continue
      const byName = out.get(host.agent) ?? new Map<string, PluginProvider>()
      for (const skill of skillsOf(plugin, host)) {
        if (byName.has(skill)) continue
        byName.set(skill, {
          plugin: plugin.name,
          itemId: plugin.item_id,
          mode,
          active:
            hostStateKey(host.state) === "active" &&
            (host.verify === null ||
              (host.verify.enabled === true &&
                host.verify.problems.length === 0)),
          invocation: pluginSkillInvocation(host, plugin.name, skill),
        })
      }
      out.set(host.agent, byName)
    }
  }
  return out
}

/** The plugins that give one agent a skill, by plugin install name: what
 *  the Skill packs' matrix needs per row. */
export function providersBySkill(
  providers: ReadonlyMap<AgentType, ReadonlyMap<string, PluginProvider>>,
  skill: string
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [agent, byName] of providers) {
    const found = byName.get(skill)
    if (found) out[agent] = found.plugin
  }
  return out
}

// ─── The chat's skill shortcuts ───────────────────────────────────────

/** The skills a plugin installed whole and on gives an agent: enabled for
 *  the chat's shortcuts. A plugin's skills only are enabled where the skills
 *  inventory sees their links (its `plugin_skills`), not by the record. */
export function pluginSkillsEnabled(
  providers: ReadonlyMap<AgentType, ReadonlyMap<string, PluginProvider>>
): [AgentType, string][] {
  const out: [AgentType, string][] = []
  for (const [agent, byName] of providers) {
    for (const [skill, provider] of byName) {
      if (provider.active && provider.mode === "native") {
        out.push([agent, skill])
      }
    }
  }
  return out
}

/** The name a shortcut invokes a skill by for one agent: the one the agent
 *  sees, where a plugin it has on gives it; the skill's own otherwise. */
export function skillInvocationOf(
  id: string,
  providers: ReadonlyMap<string, PluginProvider>
): string {
  const provider = providers.get(id)
  return provider?.active ? provider.invocation : id
}

/** Where a shortcut to a skill the agent cannot use yet sends the user: the
 *  plugin that holds the name for that agent (off, in need of repair, its
 *  link missing) — never the skill pack, whose own would then be the same
 *  skill twice. */
export function lockedSkillPlugin(
  id: string,
  providers: ReadonlyMap<string, PluginProvider>
): { plugin: string; itemId: string } | null {
  const provider = providers.get(id)
  return provider ? { plugin: provider.plugin, itemId: provider.itemId } : null
}

/**
 * The agents a plugin keeps a name from, for the Skill packs' switches: the
 * ones it gives the name to — and every agent whose link folder one of them
 * also reads, since a link put there would reach that one too.
 */
export function providersWithReaders(
  given: Readonly<Record<string, string>>,
  agents: readonly SkillsAgent[]
): Record<string, string> {
  const out: Record<string, string> = { ...given }
  for (const agent of agents) {
    if (out[agent.agent] || !agent.link_dir) continue
    const dir = agent.dirs.find((entry) => entry.path === agent.link_dir)
    const reader = (dir?.shared_with ?? []).find((other) => given[other])
    if (reader) out[agent.agent] = given[reader]
  }
  return out
}
