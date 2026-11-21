import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  CUSTOM_THEME_TOKENS,
  PLUGIN_THEME_TOKENS,
  parsePluginThemePalette,
} from "@/lib/custom-style"
import {
  MAX_NEW_WORKSPACE_COMBOBOX_OPTIONS,
  MAX_NEW_WORKSPACE_METADATA_BYTES,
  MAX_NEW_WORKSPACE_METADATA_KEYS,
  MAX_NEW_WORKSPACE_METADATA_VALUE_BYTES,
  MAX_NEW_WORKSPACE_REF_BYTES,
  MAX_NEW_WORKSPACE_ROOT_PATH_BYTES,
  MAX_NEW_WORKSPACE_SELECT_OPTIONS,
  MAX_PLUGIN_COMPOSER_INSERT_BYTES,
  MAX_PLUGIN_NEW_WORKSPACE_ITEMS,
  MAX_PLUGIN_SCREENS,
  MAX_PLUGIN_SIDEBAR_ITEMS,
  applyNewWorkspacePatch,
  hostPluginSessionScopeKey,
  pluginClientSurfaceKey,
  pluginNewWorkspaceItemKey,
  pluginScreenKey,
  pluginSidebarItemKey,
  pluginThemeKey,
  resolvePluginHostScope,
  resolvePluginHostSurface,
  resolvePluginScreen,
  resolvePluginText,
  selectPluginClientSurfaces,
  selectPluginNewWorkspaceItems,
  selectPluginScreens,
  selectPluginSidebarItems,
  selectPluginThemes,
  validateNewWorkspaceOptionsResult,
  validateNewWorkspacePatch,
  validateNewWorkspacePatchResult,
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

describe("New Workspace form items: selector, validation, and patch application", () => {
  it("loads, filters by target, and localizes examples/plugins/new-workspace-issues", () => {
    const manifestPath = resolve(
      process.cwd(),
      "examples/plugins/new-workspace-issues/codeg-plugin.json"
    )
    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf8")
    ) as InstalledPlugin["manifest"]
    const plugin: InstalledPlugin = { enabled: true, manifest }

    const workspaceZh = selectPluginNewWorkspaceItems(
      [plugin],
      "workspace",
      "zh-CN"
    )
    expect(workspaceZh).toEqual([
      {
        key: pluginNewWorkspaceItemKey("codeg.new-workspace-issues", "issue"),
        pluginId: "codeg.new-workspace-issues",
        pluginName: "新工作区工单",
        id: "issue",
        title: "工单",
        description: "根据工单建议分支名。",
        target: "all",
        control: {
          kind: "combobox",
          searchMethod: "search-issues",
          placeholder: "按工单 ID 或标题搜索",
        },
      },
    ])

    const worktreeEs = selectPluginNewWorkspaceItems([plugin], "worktree", "es")
    expect(worktreeEs).toHaveLength(2)
    expect(worktreeEs[0]?.title).toBe("Incidencia")
    expect(worktreeEs[1]).toEqual({
      key: "codeg.new-workspace-issues:draft",
      pluginId: "codeg.new-workspace-issues",
      pluginName: "Incidencias para espacios nuevos",
      id: "draft",
      title: "Marcar como borrador",
      target: "worktree",
      control: {
        kind: "toggle",
        defaultValue: false,
        enabledPatch: { metadata: { "issues.draft": true } },
        disabledPatch: { metadata: { "issues.draft": null } },
      },
    })
  })

  it("enforces enabled status, server.methods, select option exclusivity, toggle rules, and 16-item cap", () => {
    expect(MAX_PLUGIN_NEW_WORKSPACE_ITEMS).toBe(16)
    expect(MAX_NEW_WORKSPACE_COMBOBOX_OPTIONS).toBe(20)
    expect(MAX_NEW_WORKSPACE_SELECT_OPTIONS).toBe(32)

    const disabledPlugin: InstalledPlugin = {
      enabled: false,
      manifest: {
        id: "acme.disabled",
        name: "Disabled",
        version: "1.0.0",
        server: { entry: "index.mjs", methods: ["search"] },
        contributes: {
          workspacePanels: [],
          commands: [],
          hooks: [],
          newWorkspaceItems: [
            {
              id: "i1",
              title: "Disabled",
              control: { kind: "combobox", searchMethod: "search" },
            },
          ],
        },
      },
    }

    const mixedPlugin: InstalledPlugin = {
      enabled: true,
      manifest: {
        id: "acme.nw",
        name: "Acme NW",
        version: "1.0.0",
        server: { entry: "index.mjs", methods: ["search-own", "run-action"] },
        contributes: {
          workspacePanels: [],
          commands: [],
          hooks: [],
          newWorkspaceItems: [
            // Valid static select (1 option)
            {
              id: "env",
              title: "Environment",
              control: {
                kind: "select",
                options: [
                  {
                    id: "prod",
                    label: "Production",
                    patch: { metadata: { env: "prod" } },
                  },
                ],
              },
            },
            // Duplicate id rejected
            {
              id: "env",
              title: "Duplicate",
              control: { kind: "action", method: "run-action" },
            },
            // Undeclared method rejected
            {
              id: "bad-method",
              title: "Bad Method",
              control: { kind: "combobox", searchMethod: "other" },
            },
            // Select with both options and optionsMethod rejected
            {
              id: "both-select",
              title: "Both",
              control: {
                kind: "select",
                options: [{ id: "a", label: "A" }],
                optionsMethod: "search-own",
              } as never,
            },
            // Select with 0 options rejected
            {
              id: "empty-select",
              title: "Empty",
              control: { kind: "select", options: [] },
            },
            // Toggle with no method and empty patch rejected
            {
              id: "empty-toggle",
              title: "Empty Toggle",
              control: { kind: "toggle", enabledPatch: {} } as never,
            },
            // Valid action
            {
              id: "suggest",
              title: "Suggest",
              control: { kind: "action", method: "run-action" },
            },
          ],
        },
      },
    }

    const selected = selectPluginNewWorkspaceItems(
      [disabledPlugin, mixedPlugin],
      "workspace"
    )
    expect(selected.map((i) => i.id)).toEqual(["env", "suggest"])

    // 16-item per-plugin cap
    const cappedPlugin: InstalledPlugin = {
      enabled: true,
      manifest: {
        id: "acme.capped-nw",
        name: "Capped",
        version: "1.0.0",
        server: { entry: "index.mjs", methods: ["act"] },
        contributes: {
          workspacePanels: [],
          commands: [],
          hooks: [],
          newWorkspaceItems: Array.from({ length: 20 }, (_, i) => ({
            id: `item-${i + 1}`,
            title: `Item ${i + 1}`,
            control: { kind: "action" as const, method: "act" },
          })),
        },
      },
    }
    expect(
      selectPluginNewWorkspaceItems([cappedPlugin], "workspace")
    ).toHaveLength(16)
  })

  it("validates dynamic patches, options limits, and applies null-clearing patch semantics", () => {
    expect(MAX_NEW_WORKSPACE_REF_BYTES).toBe(256)
    expect(MAX_NEW_WORKSPACE_ROOT_PATH_BYTES).toBe(1024)
    expect(MAX_NEW_WORKSPACE_METADATA_KEYS).toBe(16)
    expect(MAX_NEW_WORKSPACE_METADATA_VALUE_BYTES).toBe(512)
    expect(MAX_NEW_WORKSPACE_METADATA_BYTES).toBe(4 * 1024)

    // Valid patch including explicit null clears
    const validPatch = validateNewWorkspacePatch({
      branch: "issue/demo-12",
      baseRef: null,
      rootPath: "/tmp/demo-12",
      metadata: {
        "issues.id": "DEMO-12",
        "issues.draft": true,
        priority: 2,
        removed: null,
      },
    })
    expect(validPatch).toEqual({
      branch: "issue/demo-12",
      baseRef: null,
      rootPath: "/tmp/demo-12",
      metadata: {
        "issues.id": "DEMO-12",
        "issues.draft": true,
        priority: 2,
        removed: null,
      },
    })

    // Invalid branch / baseRef
    expect(() => validateNewWorkspacePatch({ branch: "a..b" })).toThrow()
    expect(() => validateNewWorkspacePatch({ branch: "feat\0bad" })).toThrow()
    expect(() => validateNewWorkspacePatch({ baseRef: "-leading" })).toThrow()
    expect(() =>
      validateNewWorkspacePatch({ branch: "a".repeat(257) })
    ).toThrow()
    // Invalid rootPath
    expect(() => validateNewWorkspacePatch({ rootPath: "/tmp/a\nb" })).toThrow()
    expect(() =>
      validateNewWorkspacePatch({ rootPath: `/${"a".repeat(1024)}` })
    ).toThrow()
    // Invalid metadata
    expect(() =>
      validateNewWorkspacePatch({ metadata: { "bad key": "x" } })
    ).toThrow()
    expect(() =>
      validateNewWorkspacePatch({ metadata: { ok: "a\0b" } })
    ).toThrow()
    expect(() =>
      validateNewWorkspacePatch({ metadata: { ok: "a".repeat(513) } })
    ).toThrow()
    expect(() =>
      validateNewWorkspacePatch({
        metadata: Object.fromEntries(
          Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"])
        ),
      })
    ).toThrow()
    // Metadata exceeding 4 KiB total JSON
    expect(() =>
      validateNewWorkspacePatch({
        metadata: Object.fromEntries(
          Array.from({ length: 10 }, (_, i) => [`k${i}`, "x".repeat(500)])
        ),
      })
    ).toThrow()

    // Options limits: 20 for combobox, 32 for select
    const makeOpts = (n: number) => ({
      items: Array.from({ length: n }, (_, i) => ({
        id: `opt-${i}`,
        label: `Option ${i}`,
      })),
    })
    expect(
      validateNewWorkspaceOptionsResult(makeOpts(20), "combobox")
    ).toHaveLength(20)
    expect(() =>
      validateNewWorkspaceOptionsResult(makeOpts(21), "combobox")
    ).toThrow()
    expect(
      validateNewWorkspaceOptionsResult(makeOpts(32), "select")
    ).toHaveLength(32)
    expect(() =>
      validateNewWorkspaceOptionsResult(makeOpts(33), "select")
    ).toThrow()

    // Patch result wrapper
    expect(validateNewWorkspacePatchResult({})).toBeUndefined()
    expect(
      validateNewWorkspacePatchResult({ patch: { branch: "feat/ok" } })
    ).toEqual({ branch: "feat/ok" })

    // applyNewWorkspacePatch retains omitted fields & clears explicit null fields/keys
    const initial = {
      branch: "main",
      baseRef: "origin/main",
      rootPath: "/repo/a",
      metadata: { keep: "yes", drop: "old" },
    }
    const merged = applyNewWorkspacePatch(initial, {
      branch: null,
      rootPath: "/repo/b",
      metadata: { drop: null, added: 42 },
    })
    expect(merged).toEqual({
      baseRef: "origin/main",
      rootPath: "/repo/b",
      metadata: { keep: "yes", added: 42 },
    })
  })
})
