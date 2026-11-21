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
  MAX_PLUGIN_WORKSPACE_ROW_BADGES,
  MAX_WORKSPACE_ROW_BADGE_LABEL_CHARS,
  WORKSPACE_ROW_BADGE_BATCH_SIZE,
  WORKSPACE_ROW_BADGE_TONES,
  buildWorkspaceRowBadgeInputs,
  chunkWorkspaceRowBadgeInputs,
  hostPluginSessionScopeKey,
  parseWorkspaceRowBadgeResults,
  parseWorkspaceRowBadgeTone,
  pluginClientSurfaceKey,
  pluginScreenKey,
  pluginSidebarItemKey,
  pluginThemeKey,
  pluginWorkspaceRowBadgeKey,
  resolvePluginHostScope,
  resolvePluginHostSurface,
  resolvePluginScreen,
  resolvePluginText,
  sanitizeWorkspaceRowBadgeLabel,
  selectPluginClientSurfaces,
  selectPluginScreens,
  selectPluginSidebarItems,
  selectPluginThemes,
  selectPluginWorkspaceRowBadges,
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

describe("workspace row badges manifest selection, validation, and batching", () => {
  it("selects enabled workspace row badges only when method is declared in the same plugin server.methods, localizes titles, and caps at 16", () => {
    const plugins: InstalledPlugin[] = [
      {
        enabled: true,
        manifest: {
          id: "codeg.badges",
          name: "Workspace Row Badges",
          nameTranslations: {
            es: "Insignias de espacio de trabajo",
            "zh-CN": "工作区行徽标",
          },
          version: "1.0.0",
          server: {
            entry: "badges.mjs",
            methods: ["worktree-badges", "status-badges"],
          },
          contributes: {
            workspacePanels: [],
            commands: [],
            hooks: [],
            workspaceRowBadges: [
              {
                id: "worktree",
                title: "Git worktree",
                titleTranslations: {
                  es: "Árbol de trabajo de Git",
                },
                method: "worktree-badges",
              },
              {
                id: "worktree",
                title: "Duplicate worktree badge",
                method: "worktree-badges",
              },
              {
                id: "undeclared",
                title: "Missing method",
                method: "not-declared",
              },
              {
                id: "status",
                title: "Repo status",
                method: "status-badges",
              },
            ],
          },
        },
      },
      {
        enabled: true,
        manifest: {
          id: "acme.cross-method",
          name: "Cross Method Attempt",
          version: "1.0.0",
          server: {
            entry: "other.mjs",
            methods: ["own-method"],
          },
          contributes: {
            workspacePanels: [],
            commands: [],
            hooks: [],
            workspaceRowBadges: [
              // Must NOT allow calling another plugin's method name if not declared on this plugin
              {
                id: "steal",
                title: "Steal",
                method: "worktree-badges",
              },
              {
                id: "own",
                title: "Own Badge",
                method: "own-method",
              },
            ],
          },
        },
      },
      {
        enabled: true,
        manifest: {
          id: "acme.no-server",
          name: "No Server",
          version: "1.0.0",
          contributes: {
            workspacePanels: [],
            commands: [],
            hooks: [],
            workspaceRowBadges: [
              { id: "nope", title: "Nope", method: "worktree-badges" },
            ],
          },
        },
      },
      {
        enabled: false,
        manifest: {
          id: "acme.disabled",
          name: "Disabled",
          version: "1.0.0",
          server: { entry: "disabled.mjs", methods: ["disabled-badges"] },
          contributes: {
            workspacePanels: [],
            commands: [],
            hooks: [],
            workspaceRowBadges: [
              { id: "off", title: "Off", method: "disabled-badges" },
            ],
          },
        },
      },
    ]

    expect(selectPluginWorkspaceRowBadges(plugins, "es-MX")).toEqual([
      {
        key: pluginWorkspaceRowBadgeKey("codeg.badges", "worktree"),
        pluginId: "codeg.badges",
        pluginName: "Insignias de espacio de trabajo",
        id: "worktree",
        title: "Árbol de trabajo de Git",
        method: "worktree-badges",
      },
      {
        key: pluginWorkspaceRowBadgeKey("codeg.badges", "status"),
        pluginId: "codeg.badges",
        pluginName: "Insignias de espacio de trabajo",
        id: "status",
        title: "Repo status",
        method: "status-badges",
      },
      {
        key: pluginWorkspaceRowBadgeKey("acme.cross-method", "own"),
        pluginId: "acme.cross-method",
        pluginName: "Cross Method Attempt",
        id: "own",
        title: "Own Badge",
        method: "own-method",
      },
    ])

    const capped: InstalledPlugin = {
      enabled: true,
      manifest: {
        id: "acme.capped",
        name: "Capped",
        version: "1.0.0",
        server: { entry: "badges.mjs", methods: ["batch"] },
        contributes: {
          workspacePanels: [],
          commands: [],
          hooks: [],
          workspaceRowBadges: Array.from({ length: 20 }, (_, index) => ({
            id: `badge-${index + 1}`,
            title: `Badge ${index + 1}`,
            method: "batch",
          })),
        },
      },
    }
    expect(MAX_PLUGIN_WORKSPACE_ROW_BADGES).toBe(16)
    expect(selectPluginWorkspaceRowBadges([capped])).toHaveLength(16)
  })

  it("reads and resolves the bundled workspace-row-badges example manifest", () => {
    const manifestPath = resolve(
      process.cwd(),
      "examples/plugins/workspace-row-badges/codeg-plugin.json"
    )
    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf8")
    ) as InstalledPlugin["manifest"]
    const installed: InstalledPlugin = { enabled: true, manifest }

    expect(selectPluginWorkspaceRowBadges([installed], "es")).toEqual([
      {
        key: "codeg.workspace-row-badges:worktree",
        pluginId: "codeg.workspace-row-badges",
        pluginName: "Workspace Row Badges",
        id: "worktree",
        title: "Árbol de trabajo de Git",
        method: "worktree-badges",
      },
    ])
  })

  it("validates badge labels (<=32 Unicode chars, no whitespace/control anomalies) and tones", () => {
    expect(MAX_WORKSPACE_ROW_BADGE_LABEL_CHARS).toBe(32)
    expect(WORKSPACE_ROW_BADGE_TONES).toEqual([
      "muted",
      "success",
      "warning",
      "danger",
      "info",
    ])

    expect(sanitizeWorkspaceRowBadgeLabel("Git")).toBe("Git")
    expect(sanitizeWorkspaceRowBadgeLabel("PR #42")).toBe("PR #42")
    expect(sanitizeWorkspaceRowBadgeLabel("a".repeat(32))).toBe("a".repeat(32))
    // 32 emoji = 64 UTF-16 code units, 32 Unicode scalar values -> allowed
    expect(sanitizeWorkspaceRowBadgeLabel("🚀".repeat(32))).toBe(
      "🚀".repeat(32)
    )
    // 33 Unicode scalar values -> rejected
    expect(sanitizeWorkspaceRowBadgeLabel("a".repeat(33))).toBeNull()
    expect(sanitizeWorkspaceRowBadgeLabel("🚀".repeat(33))).toBeNull()

    // Empty, whitespace-only, leading/trailing whitespace, control/bidi/separator chars -> rejected
    expect(sanitizeWorkspaceRowBadgeLabel("")).toBeNull()
    expect(sanitizeWorkspaceRowBadgeLabel("   ")).toBeNull()
    expect(sanitizeWorkspaceRowBadgeLabel(" Git")).toBeNull()
    expect(sanitizeWorkspaceRowBadgeLabel("Git ")).toBeNull()
    expect(sanitizeWorkspaceRowBadgeLabel("line1\nline2")).toBeNull()
    expect(sanitizeWorkspaceRowBadgeLabel("line1\rline2")).toBeNull()
    expect(sanitizeWorkspaceRowBadgeLabel("col1\tcol2")).toBeNull()
    expect(sanitizeWorkspaceRowBadgeLabel("nul\0byte")).toBeNull()
    expect(sanitizeWorkspaceRowBadgeLabel("\x1b[31mred")).toBeNull()
    expect(sanitizeWorkspaceRowBadgeLabel("sep\u2028break")).toBeNull()
    expect(sanitizeWorkspaceRowBadgeLabel("\u200b")).toBeNull()
    expect(sanitizeWorkspaceRowBadgeLabel("bidi\u202espoof")).toBeNull()
    expect(sanitizeWorkspaceRowBadgeLabel("\ufeffbom")).toBeNull()
    expect(sanitizeWorkspaceRowBadgeLabel(123)).toBeNull()

    expect(parseWorkspaceRowBadgeTone(undefined)).toBe("muted")
    for (const tone of WORKSPACE_ROW_BADGE_TONES) {
      expect(parseWorkspaceRowBadgeTone(tone)).toBe(tone)
    }
    expect(parseWorkspaceRowBadgeTone("rainbow")).toBeNull()
    expect(parseWorkspaceRowBadgeTone(null)).toBeNull()
    expect(parseWorkspaceRowBadgeTone(42)).toBeNull()
  })

  it("parses batch results strictly: requested IDs only, deduped, ignoring malformed items", () => {
    const allowed = new Set([1, 2, 3])
    expect(parseWorkspaceRowBadgeResults({ not: "array" }, allowed).size).toBe(
      0
    )

    const parsed = parseWorkspaceRowBadgeResults(
      [
        null,
        "bad",
        { folderId: 999, label: "Unrequested", tone: "info" },
        { folderId: 1, label: "First", tone: "success" },
        { folderId: 1, label: "Duplicate", tone: "danger" },
        { folderId: 2, label: "bad\nlabel", tone: "warning" },
        { folderId: 2, label: "Valid after bad" },
        { folderId: 3, label: "Bad tone", tone: "neon" },
      ],
      allowed
    )

    expect(Array.from(parsed.entries())).toEqual([
      [1, { label: "First", tone: "success" }],
      [2, { label: "Valid after bad", tone: "muted" }],
    ])
  })

  it("builds real workspace inputs excluding chat folders and chunks into bounded batches", () => {
    const folders = [
      { id: 1, parent_id: null, git_branch: "old-main", kind: "local" },
      { id: 2, parent_id: 1, git_branch: "feat/wt", kind: "local" },
      { id: 3, parent_id: null, git_branch: "detached-old", kind: "local" },
      { id: 4, parent_id: null, git_branch: null, kind: "chat" },
      { id: 1, parent_id: null, git_branch: "dup", kind: "local" },
    ]
    const branches = new Map<number, string | null>([
      [1, "main"],
      [3, null],
    ])

    const inputs = buildWorkspaceRowBadgeInputs(folders, branches)
    expect(inputs).toEqual([
      { folderId: 1, parentFolderId: null, branch: "main" },
      { folderId: 2, parentFolderId: 1, branch: "feat/wt" },
      { folderId: 3, parentFolderId: null, branch: null },
    ])

    expect(WORKSPACE_ROW_BADGE_BATCH_SIZE).toBe(64)
    const many = Array.from({ length: 130 }, (_, index) => ({
      folderId: index + 1,
      parentFolderId: null,
      branch: null,
    }))
    const chunks = chunkWorkspaceRowBadgeInputs(many)
    expect(chunks.map((batch) => batch.length)).toEqual([64, 64, 2])
  })
})
