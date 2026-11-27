import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  CUSTOM_THEME_TOKENS,
  PLUGIN_THEME_TOKENS,
  parsePluginThemePalette,
} from "@/lib/custom-style"
import {
  MAX_PLUGIN_COMPOSER_INSERT_BYTES,
  MAX_PLUGIN_SCREENS,
  MAX_PLUGIN_SIDEBAR_ITEMS,
  MAX_PLUGIN_TIMELINE_RENDERERS,
  MAX_PLUGIN_TIMELINE_TRANSFORMERS,
  MAX_TIMELINE_TRANSFORM_ITEM_BYTES,
  MAX_TIMELINE_TRANSFORM_REPLACEMENTS,
  MAX_TIMELINE_TRANSFORM_TOOL_NAMES,
  MAX_TIMELINE_TRANSFORM_TOOL_NAME_BYTES,
  hostPluginSessionScopeKey,
  pluginClientSurfaceKey,
  pluginScreenKey,
  pluginSidebarItemKey,
  pluginThemeKey,
  pluginTimelineRendererKey,
  pluginTimelineTransformerKey,
  prepareTimelineTransformItem,
  resolvePluginHostScope,
  resolvePluginHostSurface,
  resolvePluginScreen,
  resolvePluginText,
  resolvePluginTimelineRenderer,
  selectPluginClientSurfaces,
  selectPluginScreens,
  selectPluginSidebarItems,
  selectPluginThemes,
  selectPluginTimelineRenderers,
  selectPluginTimelineTransformers,
  validatePluginComposerInsertPayload,
  validateTimelineTransformResult,
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

describe("selectPluginThemes and resolvePluginHostScope", () => {
  it("exposes all 31 color tokens from CUSTOM_THEME_TOKENS excluding radius", () => {
    expect(PLUGIN_THEME_TOKENS).not.toContain("radius")
    expect(PLUGIN_THEME_TOKENS).toHaveLength(CUSTOM_THEME_TOKENS.length - 1)
    expect(parsePluginThemePalette({ primary: "#1d4ed8" })).toEqual({
      primary: "#1d4ed8",
    })
    expect(parsePluginThemePalette({ primary: "#123" })).toBeNull()
    expect(parsePluginThemePalette({ primary: "#11223344" })).toBeNull()
    expect(
      parsePluginThemePalette({ primary: "oklch(0.5 0.2 240)" })
    ).toBeNull()
    expect(parsePluginThemePalette({ radius: "#112233" } as unknown)).toBeNull()
  })

  it("selects valid enabled plugin themes (including theme-only plugins), localizes titles, and rejects invalid palettes", () => {
    const plugins: InstalledPlugin[] = [
      {
        enabled: true,
        manifest: {
          id: "acme.nord",
          name: "Nord Suite",
          nameTranslations: {
            "zh-CN": "北极套件",
            es: "Suite Nord",
          },
          version: "1.0.0",
          // Pure theme-only plugin: no client.entry or server.entry
          contributes: {
            workspacePanels: [],
            commands: [],
            hooks: [],
            themes: [
              {
                id: "arctic",
                title: "Arctic Frost",
                titleTranslations: {
                  "zh-CN": "北极霜",
                  es: "Escarcha Ártica",
                },
                light: {
                  primary: "#5e81ac",
                  background: "#eceff4",
                },
                dark: {
                  primary: "#88c0d0",
                  background: "#2e3440",
                },
              },
              {
                id: "daylight-only",
                title: "Daylight Only",
                light: {
                  primary: "#0284c7",
                },
              },
              {
                id: "empty-both",
                title: "Empty Palettes",
                light: {},
                dark: {},
              },
              {
                id: "invalid-hex",
                title: "Invalid Hex",
                light: {
                  primary: "#abc",
                },
              },
              {
                id: "arctic",
                title: "Duplicate Arctic",
                light: {
                  primary: "#000000",
                },
              },
            ],
          },
        },
      },
      {
        enabled: false,
        manifest: {
          id: "acme.disabled-theme",
          name: "Disabled Theme Plugin",
          version: "1.0.0",
          contributes: {
            workspacePanels: [],
            commands: [],
            hooks: [],
            themes: [
              {
                id: "hidden",
                title: "Hidden Theme",
                dark: { primary: "#ff0000" },
              },
            ],
          },
        },
      },
    ]

    expect(selectPluginThemes(plugins, "zh-CN")).toEqual([
      {
        key: pluginThemeKey("acme.nord", "arctic"),
        pluginId: "acme.nord",
        pluginName: "北极套件",
        id: "arctic",
        title: "北极霜",
        light: {
          primary: "#5e81ac",
          background: "#eceff4",
        },
        dark: {
          primary: "#88c0d0",
          background: "#2e3440",
        },
      },
      {
        key: pluginThemeKey("acme.nord", "daylight-only"),
        pluginId: "acme.nord",
        pluginName: "北极套件",
        id: "daylight-only",
        title: "Daylight Only",
        light: {
          primary: "#0284c7",
        },
      },
    ])
  })

  it("gates remote window host scope until activeRemoteConnectionId matches the URL remoteConnectionId", () => {
    expect(resolvePluginHostScope("", null)).toEqual({
      scopeKey: "local",
      transportReady: true,
    })
    expect(resolvePluginHostScope("?remoteConnectionId=5", null)).toEqual({
      scopeKey: "remote:5",
      transportReady: false,
    })
    expect(resolvePluginHostScope("?remoteConnectionId=5", 3)).toEqual({
      scopeKey: "remote:5",
      transportReady: false,
    })
    expect(resolvePluginHostScope("?remoteConnectionId=5", 5)).toEqual({
      scopeKey: "remote:5",
      transportReady: true,
    })
    expect(resolvePluginHostScope("?remoteConnectionId=bad", null)).toEqual({
      scopeKey: "remote:bad",
      transportReady: false,
    })
  })
})

describe("selectPluginScreens, resolvePluginScreen, and selectPluginSidebarItems", () => {
  it("requires enabled plugins with client.entry, enforces same-plugin screenId targets, localizes titles, and respects placement", () => {
    const plugins: InstalledPlugin[] = [
      {
        enabled: true,
        manifest: {
          id: "codeg.nav",
          name: "Plugin Navigation",
          nameTranslations: {
            es: "Navegación de complementos",
            "zh-CN": "插件导航",
          },
          version: "1.0.0",
          client: { entry: "navigation.html" },
          contributes: {
            workspacePanels: [],
            commands: [],
            hooks: [],
            screens: [
              {
                id: "overview",
                title: "Plugin Overview",
                titleTranslations: {
                  es: "Resumen del complemento",
                },
              },
              {
                id: "help",
                title: "Plugin Navigation Help",
              },
              {
                id: "overview",
                title: "Duplicate Overview",
              },
            ],
            sidebarItems: [
              {
                id: "overview-nav",
                title: "Open Overview",
                titleTranslations: {
                  es: "Abrir resumen",
                },
                placement: "header",
                screenId: "overview",
              },
              {
                id: "help-nav",
                title: "Help",
                placement: "footer",
                screenId: "help",
              },
              {
                id: "missing-screen",
                title: "Broken Target",
                placement: "header",
                screenId: "does-not-exist",
              },
              {
                id: "bad-placement",
                title: "Invalid Placement",
                placement: "middle" as "header",
                screenId: "overview",
              },
            ],
          },
        },
      },
      {
        enabled: true,
        manifest: {
          id: "acme.cross",
          name: "Cross Plugin Attempt",
          version: "1.0.0",
          client: { entry: "cross.html" },
          contributes: {
            workspacePanels: [],
            commands: [],
            hooks: [],
            screens: [{ id: "own", title: "Own Screen" }],
            sidebarItems: [
              // Must NOT be able to target codeg.nav's "overview" screen
              {
                id: "steal",
                title: "Steal Overview",
                placement: "header",
                screenId: "overview",
              },
              {
                id: "valid-own",
                title: "Own Entry",
                placement: "footer",
                screenId: "own",
              },
            ],
          },
        },
      },
      {
        enabled: true,
        manifest: {
          id: "acme.no-client",
          name: "Server Only",
          version: "1.0.0",
          contributes: {
            workspacePanels: [],
            commands: [],
            hooks: [],
            screens: [{ id: "main", title: "Hidden Screen" }],
            sidebarItems: [
              {
                id: "main",
                title: "Hidden Entry",
                placement: "header",
                screenId: "main",
              },
            ],
          },
        },
      },
      {
        enabled: false,
        manifest: {
          id: "acme.disabled",
          name: "Disabled Plugin",
          version: "1.0.0",
          client: { entry: "disabled.html" },
          contributes: {
            workspacePanels: [],
            commands: [],
            hooks: [],
            screens: [{ id: "main", title: "Disabled Screen" }],
            sidebarItems: [
              {
                id: "main",
                title: "Disabled Entry",
                placement: "header",
                screenId: "main",
              },
            ],
          },
        },
      },
    ]

    expect(selectPluginScreens(plugins, "es-MX")).toEqual([
      {
        key: pluginScreenKey("codeg.nav", "overview"),
        pluginId: "codeg.nav",
        pluginName: "Navegación de complementos",
        id: "overview",
        title: "Resumen del complemento",
      },
      {
        key: pluginScreenKey("codeg.nav", "help"),
        pluginId: "codeg.nav",
        pluginName: "Navegación de complementos",
        id: "help",
        title: "Plugin Navigation Help",
      },
      {
        key: pluginScreenKey("acme.cross", "own"),
        pluginId: "acme.cross",
        pluginName: "Cross Plugin Attempt",
        id: "own",
        title: "Own Screen",
      },
    ])

    expect(resolvePluginScreen(plugins, "codeg.nav", "overview", "es")).toEqual(
      {
        key: "codeg.nav:overview",
        pluginId: "codeg.nav",
        pluginName: "Navegación de complementos",
        id: "overview",
        title: "Resumen del complemento",
      }
    )
    // Cross-plugin lookup returns null
    expect(resolvePluginScreen(plugins, "acme.cross", "overview")).toBeNull()
    expect(resolvePluginScreen(plugins, "acme.disabled", "main")).toBeNull()
    expect(resolvePluginScreen(plugins, "acme.no-client", "main")).toBeNull()

    expect(selectPluginSidebarItems(plugins, "header", "es")).toEqual([
      {
        key: pluginSidebarItemKey("codeg.nav", "overview-nav"),
        pluginId: "codeg.nav",
        pluginName: "Navegación de complementos",
        id: "overview-nav",
        title: "Abrir resumen",
        placement: "header",
        screenId: "overview",
        screenKey: "codeg.nav:overview",
        screenTitle: "Resumen del complemento",
      },
    ])

    expect(selectPluginSidebarItems(plugins, "footer", "en")).toEqual([
      {
        key: pluginSidebarItemKey("codeg.nav", "help-nav"),
        pluginId: "codeg.nav",
        pluginName: "Plugin Navigation",
        id: "help-nav",
        title: "Help",
        placement: "footer",
        screenId: "help",
        screenKey: "codeg.nav:help",
        screenTitle: "Plugin Navigation Help",
      },
      {
        key: pluginSidebarItemKey("acme.cross", "valid-own"),
        pluginId: "acme.cross",
        pluginName: "Cross Plugin Attempt",
        id: "valid-own",
        title: "Own Entry",
        placement: "footer",
        screenId: "own",
        screenKey: "acme.cross:own",
        screenTitle: "Own Screen",
      },
    ])
  })

  it("enforces the 16-entry cap per plugin for screens and sidebarItems", () => {
    const manyScreens = Array.from({ length: 20 }, (_, index) => ({
      id: `screen-${index + 1}`,
      title: `Screen ${index + 1}`,
    }))
    const manySidebarItems = Array.from({ length: 20 }, (_, index) => ({
      id: `item-${index + 1}`,
      title: `Item ${index + 1}`,
      placement: (index % 2 === 0 ? "header" : "footer") as "header" | "footer",
      screenId: `screen-${index + 1}`,
    }))
    const plugin: InstalledPlugin = {
      enabled: true,
      manifest: {
        id: "acme.capped",
        name: "Capped Plugin",
        version: "1.0.0",
        client: { entry: "index.html" },
        contributes: {
          workspacePanels: [],
          commands: [],
          hooks: [],
          screens: manyScreens,
          sidebarItems: manySidebarItems,
        },
      },
    }

    expect(MAX_PLUGIN_SCREENS).toBe(16)
    expect(MAX_PLUGIN_SIDEBAR_ITEMS).toBe(16)
    expect(selectPluginScreens([plugin])).toHaveLength(16)
    expect(
      resolvePluginScreen([plugin], "acme.capped", "screen-16")
    ).not.toBeNull()
    expect(resolvePluginScreen([plugin], "acme.capped", "screen-17")).toBeNull()
    expect(selectPluginSidebarItems([plugin])).toHaveLength(16)
  })
})

describe("selectPluginTimelineRenderers & resolvePluginTimelineRenderer", () => {
  it("loads and localizes the bundled timeline-review example manifest", () => {
    const manifestPath = resolve(
      process.cwd(),
      "examples/plugins/timeline-review/codeg-plugin.json"
    )
    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf8")
    ) as InstalledPlugin["manifest"]
    const plugin: InstalledPlugin = { enabled: true, manifest }

    expect(selectPluginTimelineRenderers([plugin], "en")).toEqual([
      {
        key: pluginTimelineRendererKey(
          "codeg.timeline-review",
          "review-result",
          1
        ),
        pluginId: "codeg.timeline-review",
        pluginName: "Timeline Review",
        kind: "review-result",
        version: 1,
        title: "Review result",
      },
    ])

    expect(
      resolvePluginTimelineRenderer(
        [plugin],
        "codeg.timeline-review",
        "review-result",
        1,
        "zh-CN"
      )
    ).toEqual({
      key: "codeg.timeline-review:review-result@1",
      pluginId: "codeg.timeline-review",
      pluginName: "Timeline Review",
      kind: "review-result",
      version: 1,
      title: "审查结果",
    })

    expect(
      resolvePluginTimelineRenderer(
        [plugin],
        "codeg.timeline-review",
        "review-result",
        1,
        "es"
      )?.title
    ).toBe("Resultado de la revisión")

    expect(
      resolvePluginTimelineRenderer(
        [plugin],
        "codeg.timeline-review",
        "review-result",
        2,
        "en"
      )
    ).toBeNull()
  })

  it("validates enabled + client.entry, kind regex, positive integer version, (kind, version) dedupe, and 16-entry cap", () => {
    expect(MAX_PLUGIN_TIMELINE_RENDERERS).toBe(16)

    const disabledPlugin: InstalledPlugin = {
      enabled: false,
      manifest: {
        id: "acme.disabled",
        name: "Disabled",
        version: "1.0.0",
        client: { entry: "index.html" },
        contributes: {
          workspacePanels: [],
          commands: [],
          hooks: [],
          timelineRenderers: [
            { kind: "review", version: 1, title: "Disabled Renderer" },
          ],
        },
      },
    }

    const noClientPlugin: InstalledPlugin = {
      enabled: true,
      manifest: {
        id: "acme.no-client",
        name: "No Client",
        version: "1.0.0",
        contributes: {
          workspacePanels: [],
          commands: [],
          hooks: [],
          timelineRenderers: [
            { kind: "review", version: 1, title: "No Client" },
          ],
        },
      },
    }

    const mixedPlugin: InstalledPlugin = {
      enabled: true,
      manifest: {
        id: "acme.timeline",
        name: "Acme Timeline",
        version: "1.0.0",
        client: { entry: "ui.html" },
        contributes: {
          workspacePanels: [],
          commands: [],
          hooks: [],
          timelineRenderers: [
            { kind: "review-result", version: 1, title: "Review v1" },
            // Same kind + different version allowed
            { kind: "review-result", version: 2, title: "Review v2" },
            // Duplicate (kind, version) skipped
            { kind: "review-result", version: 1, title: "Duplicate v1" },
            // Invalid kinds rejected
            { kind: "ReviewResult", version: 1, title: "Uppercase" },
            { kind: "1-bad", version: 1, title: "Starts with digit" },
            { kind: "bad_underscore", version: 1, title: "Underscore" },
            { kind: "a".repeat(33), version: 1, title: "Too long" },
            // Invalid versions rejected
            { kind: "zero-ver", version: 0, title: "Zero" },
            { kind: "neg-ver", version: -1, title: "Negative" },
            { kind: "float-ver", version: 1.5, title: "Float" },
            // Blank title rejected even with translations
            {
              kind: "blank-title",
              version: 1,
              title: "   ",
              titleTranslations: { "zh-CN": "有翻译无标题" },
            },
          ],
        },
      },
    }

    expect(
      selectPluginTimelineRenderers(
        [disabledPlugin, noClientPlugin, mixedPlugin],
        "zh-CN"
      )
    ).toEqual([
      {
        key: "acme.timeline:review-result@1",
        pluginId: "acme.timeline",
        pluginName: "Acme Timeline",
        kind: "review-result",
        version: 1,
        title: "Review v1",
      },
      {
        key: "acme.timeline:review-result@2",
        pluginId: "acme.timeline",
        pluginName: "Acme Timeline",
        kind: "review-result",
        version: 2,
        title: "Review v2",
      },
    ])

    // 16-renderer cap per plugin
    const cappedPlugin: InstalledPlugin = {
      enabled: true,
      manifest: {
        id: "acme.capped-timeline",
        name: "Capped",
        version: "1.0.0",
        client: { entry: "ui.html" },
        contributes: {
          workspacePanels: [],
          commands: [],
          hooks: [],
          timelineRenderers: Array.from({ length: 20 }, (_, index) => ({
            kind: `kind-${index + 1}`,
            version: 1,
            title: `Renderer ${index + 1}`,
          })),
        },
      },
    }

    const capped = selectPluginTimelineRenderers([cappedPlugin])
    expect(capped).toHaveLength(16)
    expect(
      resolvePluginTimelineRenderer(
        [cappedPlugin],
        "acme.capped-timeline",
        "kind-16",
        1
      )
    ).not.toBeNull()
    expect(
      resolvePluginTimelineRenderer(
        [cappedPlugin],
        "acme.capped-timeline",
        "kind-17",
        1
      )
    ).toBeNull()
  })
})

describe("selectPluginTimelineTransformers, validateTimelineTransformResult & prepareTimelineTransformItem", () => {
  it("loads, localizes, and filters the bundled tool-output-card example manifest", () => {
    const manifestPath = resolve(
      process.cwd(),
      "examples/plugins/tool-output-card/codeg-plugin.json"
    )
    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf8")
    ) as InstalledPlugin["manifest"]
    const plugin: InstalledPlugin = { enabled: true, manifest }

    expect(
      selectPluginTimelineTransformers([plugin], "tool_call", "bash", "en")
    ).toEqual([
      {
        key: pluginTimelineTransformerKey(
          "codeg.tool-output-card",
          "test-output"
        ),
        pluginId: "codeg.tool-output-card",
        pluginName: "Tool Output Card",
        id: "test-output",
        itemType: "tool_call",
        toolNames: ["test-runner", "bash", "Bash", "exec_command"],
        rendererKind: "test-result",
        rendererVersion: 1,
        rendererTitle: "Test result",
        method: "transform-tests",
      },
    ])

    expect(
      selectPluginTimelineTransformers([plugin], "tool_call", "Bash", "zh-CN")
    ).toMatchObject([
      {
        pluginId: "codeg.tool-output-card",
        rendererTitle: "测试结果",
      },
    ])

    expect(
      selectPluginTimelineTransformers(
        [plugin],
        "tool_call",
        "exec_command",
        "es"
      )
    ).toMatchObject([
      {
        rendererTitle: "Resultado de las pruebas",
      },
    ])

    // Case-sensitive matching: "BASH" or unrelated tool names do not match.
    expect(
      selectPluginTimelineTransformers([plugin], "tool_call", "BASH", "en")
    ).toEqual([])
    expect(
      selectPluginTimelineTransformers([plugin], "tool_call", "Read", "en")
    ).toEqual([])
    expect(
      selectPluginTimelineTransformers([plugin], "tool_call", undefined, "en")
    ).toEqual([])
    expect(
      selectPluginTimelineTransformers(
        [plugin],
        "assistant_message",
        undefined,
        "en"
      )
    ).toEqual([])
  })

  it("enforces enabled, server+client entries, same-plugin renderer & method, toolNames rules, and 16-item cap", () => {
    expect(MAX_PLUGIN_TIMELINE_TRANSFORMERS).toBe(16)
    expect(MAX_TIMELINE_TRANSFORM_REPLACEMENTS).toBe(4)
    expect(MAX_TIMELINE_TRANSFORM_TOOL_NAMES).toBe(16)
    expect(MAX_TIMELINE_TRANSFORM_TOOL_NAME_BYTES).toBe(128)

    const disabledPlugin: InstalledPlugin = {
      enabled: false,
      manifest: {
        id: "acme.disabled",
        name: "Disabled",
        version: "1.0.0",
        server: { entry: "server.mjs", methods: ["tx"] },
        client: { entry: "ui.html" },
        contributes: {
          workspacePanels: [],
          commands: [],
          hooks: [],
          timelineRenderers: [{ kind: "card", version: 1, title: "Card" }],
          timelineTransformers: [
            {
              id: "t1",
              itemType: "tool_call",
              rendererKind: "card",
              rendererVersion: 1,
              method: "tx",
            },
          ],
        },
      },
    }

    const noServerPlugin: InstalledPlugin = {
      enabled: true,
      manifest: {
        id: "acme.no-server",
        name: "No Server",
        version: "1.0.0",
        client: { entry: "ui.html" },
        contributes: {
          workspacePanels: [],
          commands: [],
          hooks: [],
          timelineRenderers: [{ kind: "card", version: 1, title: "Card" }],
          timelineTransformers: [
            {
              id: "t1",
              itemType: "tool_call",
              rendererKind: "card",
              rendererVersion: 1,
              method: "tx",
            },
          ],
        },
      },
    }

    const noClientPlugin: InstalledPlugin = {
      enabled: true,
      manifest: {
        id: "acme.no-client",
        name: "No Client",
        version: "1.0.0",
        server: { entry: "server.mjs", methods: ["tx"] },
        contributes: {
          workspacePanels: [],
          commands: [],
          hooks: [],
          timelineRenderers: [{ kind: "card", version: 1, title: "Card" }],
          timelineTransformers: [
            {
              id: "t1",
              itemType: "tool_call",
              rendererKind: "card",
              rendererVersion: 1,
              method: "tx",
            },
          ],
        },
      },
    }

    const otherPlugin: InstalledPlugin = {
      enabled: true,
      manifest: {
        id: "acme.other",
        name: "Other",
        version: "1.0.0",
        server: { entry: "server.mjs", methods: ["other-method"] },
        client: { entry: "ui.html" },
        contributes: {
          workspacePanels: [],
          commands: [],
          hooks: [],
          timelineRenderers: [
            { kind: "other-card", version: 1, title: "Other Card" },
          ],
        },
      },
    }

    const mixedPlugin: InstalledPlugin = {
      enabled: true,
      manifest: {
        id: "acme.mixed",
        name: "Mixed",
        version: "1.0.0",
        server: { entry: "server.mjs", methods: ["tx-tool", "tx-msg"] },
        client: { entry: "ui.html" },
        contributes: {
          workspacePanels: [],
          commands: [],
          hooks: [],
          timelineRenderers: [{ kind: "card", version: 1, title: "Card" }],
          timelineTransformers: [
            // Valid wildcard tool_call transformer
            {
              id: "all-tools",
              itemType: "tool_call",
              rendererKind: "card",
              rendererVersion: 1,
              method: "tx-tool",
            },
            // Duplicate ID ignored
            {
              id: "all-tools",
              itemType: "tool_call",
              rendererKind: "card",
              rendererVersion: 1,
              method: "tx-tool",
            },
            // Cross-plugin renderer rejected
            {
              id: "cross-renderer",
              itemType: "tool_call",
              rendererKind: "other-card",
              rendererVersion: 1,
              method: "tx-tool",
            },
            // Undeclared server method rejected
            {
              id: "bad-method",
              itemType: "tool_call",
              rendererKind: "card",
              rendererVersion: 1,
              method: "other-method",
            },
            // assistant_message with toolNames rejected
            {
              id: "bad-assistant",
              itemType: "assistant_message",
              toolNames: ["bash"],
              rendererKind: "card",
              rendererVersion: 1,
              method: "tx-msg",
            } as unknown as NonNullable<
              InstalledPlugin["manifest"]["contributes"]["timelineTransformers"]
            >[number],
            // Empty toolNames rejected
            {
              id: "empty-names",
              itemType: "tool_call",
              toolNames: [],
              rendererKind: "card",
              rendererVersion: 1,
              method: "tx-tool",
            },
            // Duplicate toolNames rejected
            {
              id: "dup-names",
              itemType: "tool_call",
              toolNames: ["bash", "bash"],
              rendererKind: "card",
              rendererVersion: 1,
              method: "tx-tool",
            },
            // Control char or >128 bytes toolName rejected
            {
              id: "ctrl-name",
              itemType: "tool_call",
              toolNames: ["bad\nname"],
              rendererKind: "card",
              rendererVersion: 1,
              method: "tx-tool",
            },
            {
              id: "long-name",
              itemType: "tool_call",
              toolNames: ["a".repeat(129)],
              rendererKind: "card",
              rendererVersion: 1,
              method: "tx-tool",
            },
            // Valid assistant_message transformer
            {
              id: "format-reply",
              itemType: "assistant_message",
              rendererKind: "card",
              rendererVersion: 1,
              method: "tx-msg",
            },
          ],
        },
      },
    }

    const plugins = [
      disabledPlugin,
      noServerPlugin,
      noClientPlugin,
      otherPlugin,
      mixedPlugin,
    ]
    expect(
      selectPluginTimelineTransformers(plugins, "tool_call", "any-tool")
    ).toEqual([
      {
        key: "acme.mixed:all-tools",
        pluginId: "acme.mixed",
        pluginName: "Mixed",
        id: "all-tools",
        itemType: "tool_call",
        rendererKind: "card",
        rendererVersion: 1,
        rendererTitle: "Card",
        method: "tx-tool",
      },
    ])
    expect(
      selectPluginTimelineTransformers(plugins, "assistant_message")
    ).toEqual([
      {
        key: "acme.mixed:format-reply",
        pluginId: "acme.mixed",
        pluginName: "Mixed",
        id: "format-reply",
        itemType: "assistant_message",
        rendererKind: "card",
        rendererVersion: 1,
        rendererTitle: "Card",
        method: "tx-msg",
      },
    ])

    // 16-transformer cap per plugin is counted before itemType/toolName filtering
    const cappedPlugin: InstalledPlugin = {
      enabled: true,
      manifest: {
        id: "acme.capped",
        name: "Capped",
        version: "1.0.0",
        server: { entry: "server.mjs", methods: ["tx"] },
        client: { entry: "ui.html" },
        contributes: {
          workspacePanels: [],
          commands: [],
          hooks: [],
          timelineRenderers: [{ kind: "card", version: 1, title: "Card" }],
          timelineTransformers: [
            ...Array.from({ length: 16 }, (_, index) => ({
              id: `tool-${index + 1}`,
              itemType: "tool_call" as const,
              toolNames: ["bash"],
              rendererKind: "card",
              rendererVersion: 1,
              method: "tx",
            })),
            {
              id: "assistant-17",
              itemType: "assistant_message" as const,
              rendererKind: "card",
              rendererVersion: 1,
              method: "tx",
            },
          ],
        },
      },
    }

    expect(
      selectPluginTimelineTransformers([cappedPlugin], "tool_call", "bash")
    ).toHaveLength(16)
    expect(
      selectPluginTimelineTransformers([cappedPlugin], "assistant_message")
    ).toEqual([])
  })

  it("validates timeline transform results and rejects malformed outputs", () => {
    expect(validateTimelineTransformResult(null, "test-result", 1)).toEqual({
      action: "keep",
    })
    expect(
      validateTimelineTransformResult(undefined, "test-result", 1)
    ).toEqual({ action: "keep" })
    expect(
      validateTimelineTransformResult({ action: "keep" }, "test-result", 1)
    ).toEqual({ action: "keep" })
    expect(
      validateTimelineTransformResult({ action: "omit" }, "test-result", 1)
    ).toEqual({ action: "omit" })
    expect(
      validateTimelineTransformResult(
        {
          action: "replace",
          items: [
            {
              id: "summary",
              kind: "test-result",
              version: 1,
              data: { passed: 3, failed: 0 },
            },
            {
              kind: "test-result",
              version: 1,
              data: { passed: 1, failed: 1 },
            },
          ],
        },
        "test-result",
        1
      )
    ).toEqual({
      action: "replace",
      items: [
        {
          id: "summary",
          kind: "test-result",
          version: 1,
          data: { passed: 3, failed: 0 },
        },
        {
          kind: "test-result",
          version: 1,
          data: { passed: 1, failed: 1 },
        },
      ],
    })

    // Rejects unknown fields, empty/oversized replacement arrays, kind/version mismatch, duplicate IDs, >64 KiB data
    expect(() =>
      validateTimelineTransformResult(
        { action: "keep", extra: true },
        "test-result",
        1
      )
    ).toThrow()
    expect(() =>
      validateTimelineTransformResult(
        { action: "replace", items: [] },
        "test-result",
        1
      )
    ).toThrow()
    expect(() =>
      validateTimelineTransformResult(
        {
          action: "replace",
          items: Array.from({ length: 5 }, (_, i) => ({
            id: `item-${i}`,
            kind: "test-result",
            version: 1,
            data: {},
          })),
        },
        "test-result",
        1
      )
    ).toThrow()
    expect(() =>
      validateTimelineTransformResult(
        {
          action: "replace",
          items: [{ kind: "other-kind", version: 1, data: {} }],
        },
        "test-result",
        1
      )
    ).toThrow()
    expect(() =>
      validateTimelineTransformResult(
        {
          action: "replace",
          items: [{ kind: "test-result", version: 2, data: {} }],
        },
        "test-result",
        1
      )
    ).toThrow()
    expect(() =>
      validateTimelineTransformResult(
        {
          action: "replace",
          items: [
            { id: "dup", kind: "test-result", version: 1, data: {} },
            { id: "dup", kind: "test-result", version: 1, data: {} },
          ],
        },
        "test-result",
        1
      )
    ).toThrow()
    expect(() =>
      validateTimelineTransformResult(
        {
          action: "replace",
          items: [{ id: "Bad ID", kind: "test-result", version: 1, data: {} }],
        },
        "test-result",
        1
      )
    ).toThrow()
    expect(() =>
      validateTimelineTransformResult(
        {
          action: "replace",
          items: [
            {
              kind: "test-result",
              version: 1,
              data: { blob: "x".repeat(MAX_TIMELINE_TRANSFORM_ITEM_BYTES) },
            },
          ],
        },
        "test-result",
        1
      )
    ).toThrow()
  })

  it("prepares source items cleanly and preserves the tail of oversized tool output", () => {
    expect(prepareTimelineTransformItem({ id: "   " })).toBeNull()
    expect(prepareTimelineTransformItem({ id: "bad\nid" })).toBeNull()

    const sparse = prepareTimelineTransformItem({
      id: "call-1",
      toolName: "bash",
      rawOutput: undefined,
    })
    expect(sparse).toEqual({ id: "call-1", toolName: "bash" })
    expect("rawOutput" in sparse!).toBe(false)

    const tail = "test result: ok. 12 passed; 0 failed"
    const oversized = `${"x".repeat(80_000)}\n${tail}`
    const prepared = prepareTimelineTransformItem({
      id: "call-big",
      toolName: "bash",
      rawOutput: oversized,
    })
    expect(prepared).not.toBeNull()
    expect(typeof prepared?.rawOutput).toBe("string")
    expect(prepared?.rawOutput as string).toContain(tail)
    expect(
      new TextEncoder().encode(JSON.stringify(prepared)).byteLength
    ).toBeLessThanOrEqual(MAX_TIMELINE_TRANSFORM_ITEM_BYTES)
  })
})
