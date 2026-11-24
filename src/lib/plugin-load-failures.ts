/**
 * Plugins an agent could not load (`plugin_load_failures` events).
 *
 * Claude Code 2.1.283+ lists them on every `system/init` frame as
 * `plugin_errors`, and claude-agent-acp only writes them to its own stderr —
 * they have no ACP surface. The backend reads them off the raw SDK stream codeg
 * already subscribes to and forwards a set once per connection (again only when
 * it changes), so a plugin that silently lost its commands, skills, agents or
 * MCP servers says so. It matters beyond convenience: a plugin hook that fails
 * to load can be the one guarding the permissions that plugin declares.
 *
 * Kept dependency-free so the presentation rules are unit-testable without the
 * connections provider.
 */

import type { PluginLoadFailure } from "@/lib/types"

export interface PluginLoadFailuresNotice {
  /**
   * The notification's key. The same agent failing the same plugins maps to
   * ONE notification, so every new session hitting a still-broken plugin
   * refreshes the toast and the alert-list entry instead of stacking a copy.
   */
  key: string
  /** How many plugins are affected — one plugin may report several entries. */
  count: number
  /** One line per entry: which plugin, then the CLI's own words. */
  description: string
}

/** A directory entry that failed before it had a name: `inline[0]`. */
const POSITIONAL_TAG = /^(?:inline|synced)\[\d+\]$/

/**
 * The name a failure is about. The CLI names a plugin `name@marketplace`, but a
 * directory entry that failed before it had a name only by its position, and
 * for those the path is the name a user can act on.
 */
export function pluginLoadFailureLabel(failure: PluginLoadFailure): string {
  const path = failure.path?.trim()
  return POSITIONAL_TAG.test(failure.plugin) && path ? path : failure.plugin
}

/** Shape a failure set into its notification, or `null` when it is empty. */
export function presentPluginLoadFailures(
  agentType: string,
  failures: readonly PluginLoadFailure[]
): PluginLoadFailuresNotice | null {
  if (failures.length === 0) return null
  const labels = [...new Set(failures.map(pluginLoadFailureLabel))].sort()
  const description = failures
    .map((failure) => {
      const label = pluginLoadFailureLabel(failure)
      const message = failure.message.trim()
      return message ? `${label}: ${message}` : `${label} (${failure.kind})`
    })
    .join("\n")
  return {
    key: `plugin-load:${agentType}:${labels.join("\n")}`,
    count: labels.length,
    description,
  }
}
