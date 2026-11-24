import { describe, expect, it } from "vitest"

import {
  pluginLoadFailureLabel,
  presentPluginLoadFailures,
} from "@/lib/plugin-load-failures"
import type { PluginLoadFailure } from "@/lib/types"

// The first two are what Claude Code 2.1.284 put in `system/init.plugin_errors`
// for deliberately broken directory plugins, captured live through
// claude-agent-acp 0.84.0 (paths shortened). The third is a marketplace plugin,
// named `name@marketplace` as the SDK documents it.
const MISSING_DIR: PluginLoadFailure = {
  plugin: "inline[0]",
  kind: "path-not-found",
  message: "Path not found: /tmp/p/does-not-exist (commands)",
  path: "/tmp/p/does-not-exist",
}
const CORRUPT_MANIFEST: PluginLoadFailure = {
  plugin: "inline[1]",
  kind: "generic-error",
  message:
    "Failed to load plugin: Plugin broken-plugin has a corrupt manifest file at /tmp/p/broken-plugin/.claude-plugin/plugin.json. JSON parse error: JSON Parse error: Unexpected token '}'",
  path: "/tmp/p/broken-plugin",
}
const MARKETPLACE_HOOK: PluginLoadFailure = {
  plugin: "guard@acme-marketplace",
  kind: "hook-load-failed",
  message: "hooks: must be an object mapping event names to matcher arrays",
}

describe("pluginLoadFailureLabel", () => {
  it("names a marketplace plugin by its id", () => {
    expect(pluginLoadFailureLabel(MARKETPLACE_HOOK)).toBe(
      "guard@acme-marketplace"
    )
  })

  it("names a positional directory entry by its path", () => {
    expect(pluginLoadFailureLabel(MISSING_DIR)).toBe("/tmp/p/does-not-exist")
    expect(
      pluginLoadFailureLabel({ ...MISSING_DIR, plugin: "synced[3]" })
    ).toBe("/tmp/p/does-not-exist")
  })

  it("keeps the positional tag when there is no path to show", () => {
    expect(pluginLoadFailureLabel({ ...MISSING_DIR, path: null })).toBe(
      "inline[0]"
    )
    expect(pluginLoadFailureLabel({ ...MISSING_DIR, path: "  " })).toBe(
      "inline[0]"
    )
  })

  it("does not read a path off a named plugin", () => {
    expect(
      pluginLoadFailureLabel({ ...MARKETPLACE_HOOK, path: "/somewhere" })
    ).toBe("guard@acme-marketplace")
  })
})

describe("presentPluginLoadFailures", () => {
  it("says nothing for an empty set", () => {
    expect(presentPluginLoadFailures("claude_code", [])).toBeNull()
  })

  it("lists every entry under the plugin it is about", () => {
    const notice = presentPluginLoadFailures("claude_code", [
      MISSING_DIR,
      CORRUPT_MANIFEST,
    ])
    expect(notice).toEqual({
      key: "plugin-load:claude_code:/tmp/p/broken-plugin\n/tmp/p/does-not-exist",
      count: 2,
      description:
        "/tmp/p/does-not-exist: Path not found: /tmp/p/does-not-exist (commands)\n" +
        "/tmp/p/broken-plugin: Failed to load plugin: Plugin broken-plugin has a corrupt manifest file at /tmp/p/broken-plugin/.claude-plugin/plugin.json. JSON parse error: JSON Parse error: Unexpected token '}'",
    })
  })

  it("counts plugins, not entries", () => {
    const notice = presentPluginLoadFailures("claude_code", [
      MARKETPLACE_HOOK,
      { ...MARKETPLACE_HOOK, kind: "generic-error", message: "mcp: bad" },
    ])
    expect(notice?.count).toBe(1)
    expect(notice?.description.split("\n")).toHaveLength(2)
  })

  it("keys the same failing plugins the same way whatever their order", () => {
    const a = presentPluginLoadFailures("claude_code", [
      MISSING_DIR,
      MARKETPLACE_HOOK,
    ])
    const b = presentPluginLoadFailures("claude_code", [
      MARKETPLACE_HOOK,
      { ...MISSING_DIR, message: "reworded" },
    ])
    expect(a?.key).toBe(b?.key)
    // …but per agent, so two agents never share one entry.
    expect(presentPluginLoadFailures("custom", [MISSING_DIR])?.key).not.toBe(
      presentPluginLoadFailures("claude_code", [MISSING_DIR])?.key
    )
  })

  it("falls back to the category when the CLI gave no message", () => {
    const notice = presentPluginLoadFailures("claude_code", [
      { ...MARKETPLACE_HOOK, message: " " },
    ])
    expect(notice?.description).toBe(
      "guard@acme-marketplace (hook-load-failed)"
    )
  })
})
