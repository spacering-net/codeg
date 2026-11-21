import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  MAX_PLUGIN_COMPOSER_INSERT_BYTES,
  hostPluginSessionScopeKey,
  pluginClientSurfaceKey,
  resolvePluginHostSurface,
  resolvePluginText,
  selectPluginClientSurfaces,
  validatePluginComposerInsertPayload,
  type InstalledPlugin,
  type PluginTextTranslations,
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

describe("validatePluginComposerInsertPayload", () => {
  it("accepts valid text and normalizes CRLF/CR line endings", () => {
    expect(
      validatePluginComposerInsertPayload({
        type: "insertText",
        text: "line1\r\nline2\rline3",
      })
    ).toBe("line1\nline2\nline3")
  })

  it("enforces UTF-8 byte length limits, non-empty text, and payload shape", () => {
    expect(() => validatePluginComposerInsertPayload(null)).toThrow(
      /Invalid composer insertion payload/
    )
    expect(() =>
      validatePluginComposerInsertPayload({ type: "replace", text: "hi" })
    ).toThrow(/Invalid composer insertion payload/)
    expect(() =>
      validatePluginComposerInsertPayload({ type: "insertText", text: 123 })
    ).toThrow(/Invalid composer insertion payload/)
    expect(() =>
      validatePluginComposerInsertPayload({ type: "insertText", text: "" })
    ).toThrow(/non-empty/)
    expect(() =>
      validatePluginComposerInsertPayload({
        type: "insertText",
        text: "bad\0text",
      })
    ).toThrow(/control characters/)

    const exactLimit = "a".repeat(MAX_PLUGIN_COMPOSER_INSERT_BYTES)
    expect(
      validatePluginComposerInsertPayload({
        type: "insertText",
        text: exactLimit,
      })
    ).toBe(exactLimit)

    const overAscii = "a".repeat(MAX_PLUGIN_COMPOSER_INSERT_BYTES + 1)
    expect(() =>
      validatePluginComposerInsertPayload({
        type: "insertText",
        text: overAscii,
      })
    ).toThrow(/16 KiB/)

    // Multi-byte UTF-8 characters are measured in bytes, not JS UTF-16 code units.
    const overUtf8 = "中".repeat(
      Math.floor(MAX_PLUGIN_COMPOSER_INSERT_BYTES / 3) + 1
    )
    expect(() =>
      validatePluginComposerInsertPayload({
        type: "insertText",
        text: overUtf8,
      })
    ).toThrow(/16 KiB/)
  })
})

describe("resolvePluginHostSurface", () => {
  it("resolves pluginDetail, activationPanel, and settingsPanel only for enabled plugins with client.entry", () => {
    const enabledWithClient: InstalledPlugin = {
      enabled: true,
      manifest: {
        id: "acme.full",
        name: "Acme Full",
        version: "1.0.0",
        client: { entry: "panel.html" },
        contributes: {
          workspacePanels: [],
          commands: [],
          hooks: [],
          pluginDetail: { id: "detail", title: "About Acme" },
          activationPanel: { id: "onboard", title: "Get Started" },
          settingsPanel: { id: "prefs", title: "Preferences" },
        },
      },
    }

    expect(resolvePluginHostSurface(enabledWithClient, "pluginDetail")).toEqual(
      { id: "detail", title: "About Acme" }
    )
    expect(
      resolvePluginHostSurface(enabledWithClient, "activationPanel")
    ).toEqual({ id: "onboard", title: "Get Started" })
    expect(
      resolvePluginHostSurface(enabledWithClient, "settingsPanel")
    ).toEqual({ id: "prefs", title: "Preferences" })

    const disabled: InstalledPlugin = {
      ...enabledWithClient,
      enabled: false,
    }
    expect(resolvePluginHostSurface(disabled, "pluginDetail")).toBeNull()
    expect(resolvePluginHostSurface(disabled, "activationPanel")).toBeNull()
    expect(resolvePluginHostSurface(disabled, "settingsPanel")).toBeNull()

    const noClientEntry: InstalledPlugin = {
      ...enabledWithClient,
      manifest: {
        ...enabledWithClient.manifest,
        client: undefined,
      },
    }
    expect(resolvePluginHostSurface(noClientEntry, "pluginDetail")).toBeNull()
    expect(
      resolvePluginHostSurface(noClientEntry, "activationPanel")
    ).toBeNull()
    expect(resolvePluginHostSurface(noClientEntry, "settingsPanel")).toBeNull()

    const blankFields: InstalledPlugin = {
      ...enabledWithClient,
      manifest: {
        ...enabledWithClient.manifest,
        contributes: {
          ...enabledWithClient.manifest.contributes,
          pluginDetail: { id: "   ", title: "About" },
          activationPanel: { id: "setup", title: "   " },
        },
      },
    }
    expect(resolvePluginHostSurface(blankFields, "pluginDetail")).toBeNull()
    expect(resolvePluginHostSurface(blankFields, "activationPanel")).toBeNull()
  })

  it("validates the workspace-inspector example manifest and client entry across all surfaces", () => {
    const manifestPath = resolve(
      process.cwd(),
      "examples/plugins/workspace-inspector/codeg-plugin.json"
    )
    const htmlPath = resolve(
      process.cwd(),
      "examples/plugins/workspace-inspector/inspector.html"
    )
    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf8")
    ) as InstalledPlugin["manifest"]
    const html = readFileSync(htmlPath, "utf8")

    expect(manifest.id).toBe("codeg.workspace-inspector")
    expect(manifest.version).toBe("1.1.0")
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('label for="workspace-label"')
    expect(html).toContain("window.codeg.composer.insertText")

    const installed: InstalledPlugin = {
      enabled: true,
      manifest,
    }
    expect(resolvePluginHostSurface(installed, "settingsPanel")).toEqual({
      id: "about",
      title: "About Workspace Inspector",
    })
    expect(resolvePluginHostSurface(installed, "pluginDetail")).toEqual({
      id: "detail",
      title: "Workspace Inspector Details",
    })
    expect(resolvePluginHostSurface(installed, "activationPanel")).toEqual({
      id: "setup",
      title: "Set Up Workspace Inspector",
    })
    expect(selectPluginClientSurfaces([installed], "sessionHeader")).toEqual([
      {
        key: "codeg.workspace-inspector:session",
        pluginId: "codeg.workspace-inspector",
        pluginName: "Workspace Inspector",
        id: "session",
        title: "Inspect session",
        slot: "sessionHeader",
      },
    ])
    expect(selectPluginClientSurfaces([installed], "composer")).toEqual([
      {
        key: "codeg.workspace-inspector:draft",
        pluginId: "codeg.workspace-inspector",
        pluginName: "Workspace Inspector",
        id: "draft",
        title: "Inspect draft",
        slot: "composer",
      },
    ])
  })
})

describe("resolvePluginText and localized *Translations contributions", () => {
  const nameTranslations: PluginTextTranslations = {
    zh: "工作区检查器（通用中文）",
    "zh-CN": "工作区检查器",
    "zh-Hans-CN": "工作区检查器（简体中国）",
    es: "Inspector del espacio",
  }

  it("returns plain strings when translations are omitted and follows exact locale > base language > default fallback", () => {
    expect(resolvePluginText("Plain Title", undefined, "zh-CN")).toBe(
      "Plain Title"
    )
    // Exact regional match beats base language
    expect(
      resolvePluginText("Workspace Inspector", nameTranslations, "zh-CN")
    ).toBe("工作区检查器")
    // Case-normalized exact match (language[-Script][-REGION])
    expect(
      resolvePluginText("Workspace Inspector", nameTranslations, "zh-cn")
    ).toBe("工作区检查器")
    expect(
      resolvePluginText("Workspace Inspector", nameTranslations, "zh-hans-cn")
    ).toBe("工作区检查器（简体中国）")
    // Base language fallback when regional variant is absent
    expect(
      resolvePluginText("Workspace Inspector", nameTranslations, "zh-TW")
    ).toBe("工作区检查器（通用中文）")
    expect(
      resolvePluginText("Workspace Inspector", nameTranslations, "es-MX")
    ).toBe("Inspector del espacio")
    // Default fallback when neither exact nor base language exists
    expect(
      resolvePluginText("Workspace Inspector", nameTranslations, "ja-JP")
    ).toBe("Workspace Inspector")
    expect(
      resolvePluginText("Workspace Inspector", nameTranslations, undefined)
    ).toBe("Workspace Inspector")
  })

  it("resolves localized host and client surface titles per locale while keeping manifest fields as strings", () => {
    const plugin: InstalledPlugin = {
      enabled: true,
      manifest: {
        id: "acme.i18n",
        name: "Workspace Inspector",
        nameTranslations,
        version: "1.0.0",
        client: { entry: "client.html" },
        contributes: {
          workspacePanels: [],
          commands: [],
          hooks: [],
          pluginDetail: {
            id: "detail",
            title: "Inspector Details",
            titleTranslations: {
              "zh-CN": "检查器详情",
              es: "Detalles del inspector",
            },
          },
          clientSurfaces: [
            {
              id: "hdr",
              slot: "sessionHeader",
              title: "Session Check",
              titleTranslations: {
                "zh-CN": "会话检查",
                es: "Revisión de sesión",
              },
            },
          ],
        },
      },
    }

    expect(typeof plugin.manifest.name).toBe("string")
    expect(resolvePluginHostSurface(plugin, "pluginDetail", "zh-CN")).toEqual({
      id: "detail",
      title: "检查器详情",
    })
    expect(resolvePluginHostSurface(plugin, "pluginDetail", "es-AR")).toEqual({
      id: "detail",
      title: "Detalles del inspector",
    })
    expect(resolvePluginHostSurface(plugin, "pluginDetail", "de")).toEqual({
      id: "detail",
      title: "Inspector Details",
    })

    expect(
      selectPluginClientSurfaces([plugin], "sessionHeader", "zh-CN")
    ).toEqual([
      {
        key: "acme.i18n:hdr",
        pluginId: "acme.i18n",
        pluginName: "工作区检查器",
        id: "hdr",
        title: "会话检查",
        slot: "sessionHeader",
      },
    ])
    expect(
      selectPluginClientSurfaces([plugin], "sessionHeader", "es-ES")
    ).toEqual([
      {
        key: "acme.i18n:hdr",
        pluginId: "acme.i18n",
        pluginName: "Inspector del espacio",
        id: "hdr",
        title: "Revisión de sesión",
        slot: "sessionHeader",
      },
    ])
  })
})
