import { describe, expect, it } from "vitest"
import {
  hostPluginSessionScopeKey,
  pluginClientSurfaceKey,
  selectPluginClientSurfaces,
  type InstalledPlugin,
} from "@/lib/host-plugins"

function makePlugin(
  overrides: Partial<InstalledPlugin> & {
    id: string
    name?: string
    clientEntry?: string | null
    clientSurfaces?: InstalledPlugin["manifest"]["contributes"]["clientSurfaces"]
  }
): InstalledPlugin {
  return {
    enabled: overrides.enabled ?? true,
    manifest: {
      id: overrides.id,
      name: overrides.name ?? overrides.id,
      version: "1.0.0",
      client:
        overrides.clientEntry === null
          ? undefined
          : { entry: overrides.clientEntry ?? "index.html" },
      contributes: {
        workspacePanels: [],
        commands: [],
        hooks: [],
        clientSurfaces: overrides.clientSurfaces,
      },
    },
  }
}

describe("selectPluginClientSurfaces", () => {
  it("selects only enabled plugins with client.entry matching the requested slot", () => {
    const plugins: InstalledPlugin[] = [
      makePlugin({
        id: "alpha",
        name: "Alpha Plugin",
        enabled: true,
        clientEntry: "ui.html",
        clientSurfaces: [
          { id: "hdr", title: "Session Inspector", slot: "sessionHeader" },
          { id: "cmp", title: "Prompt Helper", slot: "composer" },
        ],
      }),
      makePlugin({
        id: "disabled-plugin",
        enabled: false,
        clientEntry: "ui.html",
        clientSurfaces: [
          { id: "hdr", title: "Hidden Disabled", slot: "sessionHeader" },
        ],
      }),
      makePlugin({
        id: "no-client-entry",
        enabled: true,
        clientEntry: null,
        clientSurfaces: [
          { id: "hdr", title: "Hidden No Entry", slot: "sessionHeader" },
          { id: "cmp", title: "Hidden Composer", slot: "composer" },
        ],
      }),
      makePlugin({
        id: "blank-client-entry",
        enabled: true,
        clientEntry: "   ",
        clientSurfaces: [
          { id: "hdr", title: "Blank Entry", slot: "sessionHeader" },
        ],
      }),
      makePlugin({
        id: "beta",
        name: "Beta Plugin",
        enabled: true,
        clientEntry: "beta.html",
        clientSurfaces: [
          { id: "tools", title: "Context Picker", slot: "composer" },
        ],
      }),
    ]

    expect(selectPluginClientSurfaces(plugins, "sessionHeader")).toEqual([
      {
        key: "alpha:hdr",
        pluginId: "alpha",
        pluginName: "Alpha Plugin",
        id: "hdr",
        title: "Session Inspector",
        slot: "sessionHeader",
      },
    ])

    expect(selectPluginClientSurfaces(plugins, "composer")).toEqual([
      {
        key: "alpha:cmp",
        pluginId: "alpha",
        pluginName: "Alpha Plugin",
        id: "cmp",
        title: "Prompt Helper",
        slot: "composer",
      },
      {
        key: "beta:tools",
        pluginId: "beta",
        pluginName: "Beta Plugin",
        id: "tools",
        title: "Context Picker",
        slot: "composer",
      },
    ])
  })

  it("deduplicates duplicate surface ids within a plugin and skips blank ids or titles", () => {
    const plugins: InstalledPlugin[] = [
      makePlugin({
        id: "dup",
        name: "Dup",
        clientSurfaces: [
          { id: "one", title: "First", slot: "composer" },
          { id: "one", title: "Duplicate", slot: "composer" },
          { id: "  ", title: "Missing ID", slot: "composer" },
          { id: "two", title: "   ", slot: "composer" },
        ],
      }),
    ]

    expect(selectPluginClientSurfaces(plugins, "composer")).toEqual([
      {
        key: pluginClientSurfaceKey("dup", "one"),
        pluginId: "dup",
        pluginName: "Dup",
        id: "one",
        title: "First",
        slot: "composer",
      },
    ])
  })

  it("handles undefined or empty catalogs", () => {
    expect(selectPluginClientSurfaces(undefined, "sessionHeader")).toEqual([])
    expect(selectPluginClientSurfaces([], "composer")).toEqual([])
  })
})

describe("hostPluginSessionScopeKey", () => {
  it("distinguishes workspace, persisted conversation, and draft session keys", () => {
    const a = hostPluginSessionScopeKey({
      folderId: 1,
      conversationId: 10,
      sessionKey: "tab-1",
    })
    const b = hostPluginSessionScopeKey({
      folderId: 2,
      conversationId: 10,
      sessionKey: "tab-1",
    })
    const c = hostPluginSessionScopeKey({
      folderId: 1,
      conversationId: null,
      sessionKey: "tab-1",
    })
    const d = hostPluginSessionScopeKey({
      folderId: null,
      conversationId: null,
      sessionKey: "tab-2",
    })

    expect(new Set([a, b, c, d]).size).toBe(4)
  })
})
