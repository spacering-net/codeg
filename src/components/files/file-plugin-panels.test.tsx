import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FileWorkspaceTab } from "@/contexts/workspace-context"
import enMessages from "@/i18n/messages/en.json"
import esMessages from "@/i18n/messages/es.json"
import type { InstalledPlugin } from "@/lib/host-plugins"
import type { Transport } from "@/lib/transport"
import { HostPluginSurface } from "@/components/host-plugin-surface"
import { MobileWorkspacePanes } from "@/components/layout/mobile-workspace-panes"
import { OverlayHostHiddenProvider } from "@/components/ui/overlay-host-hidden"

const mocks = vi.hoisted(() => ({
  transport: null as Transport | null,
  activeRemoteId: null as number | null,
  listeners: new Set<() => void>(),
  activeFileTab: null as FileWorkspaceTab | null,
  fileTabs: [] as FileWorkspaceTab[],
  previewFileTabIds: new Set<string>(),
  pendingFileReveal: null as {
    requestId: number
    path: string
    line: number
  } | null,
  toggleFileTabPreview: vi.fn(),
  consumePendingFileReveal: vi.fn(),
  updateFileTabContent: vi.fn(),
  saveActiveFile: vi.fn(),
  setFileTabComposing: vi.fn(),
  openFilePreview: vi.fn(),
  openWorkingTreeDiff: vi.fn(),
  openBranchDiff: vi.fn(),
  openCommitDiff: vi.fn(),
  allFolders: [{ id: 1, path: "/repo" }],
  readFileForEditSpy: vi.fn(),
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => {
    if (!mocks.transport) {
      throw new Error("Mock transport not configured")
    }
    return mocks.transport
  },
  getActiveRemoteConnectionId: () => mocks.activeRemoteId,
  subscribeTransportChange: (listener: () => void) => {
    mocks.listeners.add(listener)
    return () => {
      mocks.listeners.delete(listener)
    }
  },
  isDesktop: () => false,
  isRemoteDesktopMode: () => mocks.activeRemoteId !== null,
}))

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceFileTabs: () => ({
    activeFileTab: mocks.activeFileTab,
    activeFileTabId: mocks.activeFileTab?.id ?? null,
    fileTabs: mocks.fileTabs,
    allFileTabs: mocks.fileTabs,
    previewFileTabIds: mocks.previewFileTabIds,
    pendingFileReveal: mocks.pendingFileReveal,
  }),
  useWorkspaceActions: () => ({
    toggleFileTabPreview: mocks.toggleFileTabPreview,
    consumePendingFileReveal: mocks.consumePendingFileReveal,
    updateFileTabContent: mocks.updateFileTabContent,
    saveActiveFile: mocks.saveActiveFile,
    setFileTabComposing: mocks.setFileTabComposing,
    openFilePreview: mocks.openFilePreview,
    openWorkingTreeDiff: mocks.openWorkingTreeDiff,
    openBranchDiff: mocks.openBranchDiff,
    openCommitDiff: mocks.openCommitDiff,
  }),
}))

vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: (
    select: (state: { allFolders: typeof mocks.allFolders }) => unknown
  ) => select({ allFolders: mocks.allFolders }),
}))

vi.mock("@/contexts/tab-context", () => ({
  useTabStore: (
    select: (state: { tabs: unknown[]; activeTabId: string | null }) => unknown
  ) => select({ tabs: [], activeTabId: null }),
}))

vi.mock("@/contexts/monaco-model-context", () => ({
  useTrackMonacoModel: () => () => {},
}))

vi.mock("@/hooks/use-appearance", () => ({
  useZoomLevel: () => ({ zoomLevel: 100 }),
  useEditorFont: () => ({
    editorFontStack: "monospace",
    editorFontSize: 13,
    editorLigatures: false,
    editorWordWrap: false,
    setEditorWordWrap: vi.fn(),
  }),
}))

vi.mock("@/lib/monaco-local", () => ({}))
vi.mock("@/lib/monaco-themes", () => ({
  defineMonacoThemes: vi.fn(),
  MONACO_UNICODE_HIGHLIGHT_OPTIONS: {},
  useMonacoWorkspaceTheme: () => "vs-dark",
}))

vi.mock("next/dynamic", () => ({
  default: () =>
    function MockMonacoEditor(props: {
      path?: string
      value?: string
      defaultValue?: string
    }) {
      return (
        <div
          data-testid="monaco-editor"
          data-path={props.path ?? ""}
          data-value={props.value ?? props.defaultValue ?? ""}
        />
      )
    },
}))

vi.mock("@/components/files/file-path-breadcrumb", () => ({
  FilePathBreadcrumb: ({
    fileName,
    isDirty,
  }: {
    fileName: string
    isDirty?: boolean
  }) => (
    <span data-testid="file-breadcrumb">
      {fileName}
      {isDirty ? " *" : ""}
    </span>
  ),
}))

vi.mock("@/components/files/markdown-document-preview", () => ({
  MarkdownDocumentPreview: ({ content }: { content: string }) => (
    <div data-testid="markdown-preview" data-content={content} />
  ),
}))

vi.mock("@/components/files/html-preview", async () => {
  const { usePublishHtmlPreviewControls } =
    await import("@/components/files/html-preview-controls")
  const { useMemo } = await import("react")
  return {
    HtmlPreview: ({ tab }: { tab: FileWorkspaceTab }) => {
      const controls = useMemo(
        () => ({
          scripts: {
            on: false,
            disabled: false,
            label: "Enable scripts",
            hint: "Run scripts",
            toggle: vi.fn(),
          },
          reload: null,
          switchEngine: null,
          note: null,
        }),
        []
      )
      usePublishHtmlPreviewControls(tab.id, controls)
      return <div data-testid="html-preview" data-content={tab.content} />
    },
  }
})

vi.mock("@/components/files/image-preview", () => ({
  ImagePreview: ({ tab }: { tab: FileWorkspaceTab }) => (
    <div data-testid="image-preview" data-title={tab.title} />
  ),
}))

vi.mock("@/components/files/pdf-preview", () => ({
  PdfPreview: ({ tab }: { tab: FileWorkspaceTab }) => (
    <div data-testid="pdf-preview" data-title={tab.title} />
  ),
}))

vi.mock("@/components/files/kept-office-previews", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/components/files/kept-office-previews")
    >()
  return {
    ...actual,
    KeptOfficePreviews: () => <div data-testid="kept-office-previews" />,
  }
})

vi.mock("@/components/browser/browser-tab-view", () => ({
  BrowserTabView: () => <div data-testid="browser-tab-view" />,
}))

vi.mock("@/components/diff/diff-viewer", () => ({
  DiffViewer: () => <div data-testid="diff-viewer" />,
}))

vi.mock("@/components/diff/image-diff-view", () => ({
  ImageDiffView: () => <div data-testid="image-diff-view" />,
}))

vi.mock("@/components/diff/unified-diff-preview", () => ({
  UnifiedDiffPreview: () => <div data-testid="unified-diff-preview" />,
}))

vi.mock("@/lib/platform", () => ({
  openPath: vi.fn(() => Promise.resolve()),
}))

vi.mock("@/lib/api", () => ({
  downloadWorkspaceFile: vi.fn(() => Promise.resolve({ status: "started" })),
  isWorkspaceFileApiAvailable: () => false,
  WORKSPACE_DOWNLOAD_CANCELLED: "cancelled",
  readFileForEdit: mocks.readFileForEditSpy,
}))

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
  }),
}))

import { resetFilePluginPanelSelectionForTests } from "./file-plugin-panels"
import { resetHtmlPreviewControlsForTests } from "./html-preview-controls"
import { FileWorkspaceHeader } from "./file-workspace-header"
import { FileWorkspacePanel } from "./file-workspace-panel"

class FakeMessagePort {
  onmessage: ((event: { data: unknown }) => void) | null = null
  closed = false
  peer!: FakeMessagePort

  postMessage(data: unknown) {
    if (this.closed) return
    if (this.peer && !this.peer.closed) {
      this.peer.onmessage?.({ data })
    }
  }

  close() {
    this.closed = true
  }
}

class FakeMessageChannel {
  port1 = new FakeMessagePort()
  port2 = new FakeMessagePort()
  constructor() {
    this.port1.peer = this.port2
    this.port2.peer = this.port1
  }
}

function notifyTransportChange() {
  for (const listener of [...mocks.listeners]) {
    listener()
  }
}

function makeCsvViewerPlugin(overrides?: {
  enabled?: boolean
  clientEntry?: string | null
  filePanels?: InstalledPlugin["manifest"]["contributes"]["filePanels"]
}): InstalledPlugin {
  return {
    enabled: overrides?.enabled ?? true,
    manifest: {
      id: "codeg.csv-viewer",
      name: "CSV Viewer",
      nameTranslations: { es: "Visor CSV" },
      version: "1.0.0",
      ...(overrides?.clientEntry === null
        ? {}
        : { client: { entry: overrides?.clientEntry ?? "viewer.html" } }),
      contributes: {
        workspacePanels: [],
        commands: [],
        hooks: [],
        filePanels: overrides?.filePanels ?? [
          {
            id: "table",
            title: "Table View",
            titleTranslations: { es: "Vista de tabla" },
            extensions: ["csv", "tsv"],
          },
          {
            id: "outline",
            title: "Doc Outline",
            extensions: ["md", "html"],
          },
        ],
      },
    },
  }
}

function makeMockTransport(options: {
  getPlugins: () => InstalledPlugin[]
  htmlByPlugin?: Record<string, string>
  onHtmlFetch?: (pluginId: string) => void
}) {
  const eventListeners = new Map<string, Set<(payload: unknown) => void>>()
  const calls: { method: string; params?: Record<string, unknown> }[] = []

  const transport: Transport = {
    async call<T>(
      method: string,
      params?: Record<string, unknown>
    ): Promise<T> {
      calls.push({ method, params })
      if (method === "host_plugins_list") {
        return options.getPlugins() as T
      }
      if (method === "host_plugins_client_html") {
        const pluginId = String(params?.pluginId ?? "")
        options.onHtmlFetch?.(pluginId)
        return (options.htmlByPlugin?.[pluginId] ??
          "<div id='plugin-viewer'>Viewer</div>") as T
      }
      throw new Error(`Unexpected transport call: ${method}`)
    },
    async subscribe<T>(event: string, cb: (payload: T) => void) {
      let set = eventListeners.get(event)
      if (!set) {
        set = new Set()
        eventListeners.set(event, set)
      }
      const wrapped = cb as (payload: unknown) => void
      set.add(wrapped)
      return () => {
        set?.delete(wrapped)
      }
    },
    isDesktop: () => false,
  }

  return {
    transport,
    calls,
    emit(event: string, payload: unknown) {
      for (const listener of eventListeners.get(event) ?? []) {
        listener(payload)
      }
    },
  }
}

function makeFileTab(
  overrides: Partial<FileWorkspaceTab> = {}
): FileWorkspaceTab {
  return {
    id: "file:/repo/data.csv",
    kind: "file",
    folderId: null,
    title: "data.csv",
    description: "/repo/data.csv",
    path: "/repo/data.csv",
    language: "plaintext",
    content: "name,score\nalice,42\n",
    savedContent: "name,score\nalice,42\n",
    isDirty: false,
    etag: "etag-1",
    mtimeMs: 1_700_000_000_000,
    readonly: false,
    saveState: "idle",
    saveError: null,
    loadError: null,
    loading: false,
    ...overrides,
  } as FileWorkspaceTab
}

async function openDropdown(trigger: HTMLElement) {
  await act(async () => {
    for (const type of ["pointerdown", "pointerup", "click"]) {
      fireEvent(
        trigger,
        new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function connectPluginIframe(iframe: HTMLIFrameElement) {
  const srcDoc = iframe.getAttribute("srcdoc") ?? ""
  const keyMatch = srcDoc.match(/const key = "([0-9a-f]+)"/)
  expect(keyMatch).not.toBeNull()
  const key = keyMatch![1]

  let clientPort: FakeMessagePort | null = null
  const fakeWindow = {
    postMessage: (
      data: { type?: string },
      _origin: string,
      transfer?: unknown[]
    ) => {
      if (data?.type === "codeg-plugin-port" && transfer?.[0]) {
        clientPort = transfer[0] as FakeMessagePort
      }
    },
  }
  Object.defineProperty(iframe, "contentWindow", {
    configurable: true,
    value: fakeWindow,
  })

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "null",
        source: fakeWindow as unknown as MessageEventSource,
        data: { type: "codeg-plugin-ready", key },
      })
    )
  })
  expect(clientPort).not.toBeNull()

  const received: unknown[] = []
  clientPort!.onmessage = ({ data }) => {
    received.push(data)
  }

  await act(async () => {
    clientPort!.postMessage({ type: "authenticate", key })
    await Promise.resolve()
  })

  const contextMsg = received.find(
    (msg) => (msg as { type?: string })?.type === "context"
  ) as { type: "context"; context: Record<string, unknown> } | undefined
  expect(contextMsg).toBeDefined()

  let seq = 0
  const sendOperation = async (operation: string, payload: unknown) => {
    const id = ++seq
    const before = received.length
    await act(async () => {
      clientPort!.postMessage({
        id,
        operation,
        json: JSON.stringify(payload),
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    return received
      .slice(before)
      .find((msg) => (msg as { id?: number })?.id === id) as
      | { id: number; ok: boolean; value?: unknown; error?: string }
      | undefined
  }

  return {
    srcDoc,
    port: clientPort!,
    context: contextMsg!.context,
    sendOperation,
  }
}

function renderFileColumn(locale: "en" | "es" = "en") {
  const messages = locale === "es" ? esMessages : enMessages
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <div className="flex h-[480px] w-[320px] flex-col">
        <FileWorkspaceHeader />
        <div className="flex-1 min-h-0">
          <FileWorkspacePanel />
        </div>
      </div>
    </NextIntlClientProvider>
  )
}

const originalMessageChannel = globalThis.MessageChannel

describe("FileWorkspace plugin filePanels integration", () => {
  beforeEach(() => {
    globalThis.MessageChannel =
      FakeMessageChannel as unknown as typeof MessageChannel
    window.history.replaceState({}, "", "/workspace")
    mocks.activeRemoteId = null
    mocks.transport = null
    mocks.listeners.clear()
    mocks.activeFileTab = null
    mocks.fileTabs = []
    mocks.previewFileTabIds = new Set()
    mocks.pendingFileReveal = null
    mocks.toggleFileTabPreview.mockReset()
    mocks.toggleFileTabPreview.mockImplementation((tabId: string) => {
      const next = new Set(mocks.previewFileTabIds)
      if (next.has(tabId)) next.delete(tabId)
      else next.add(tabId)
      mocks.previewFileTabIds = next
    })
    mocks.consumePendingFileReveal.mockReset()
    mocks.readFileForEditSpy.mockReset()
    resetFilePluginPanelSelectionForTests()
    resetHtmlPreviewControlsForTests()
  })

  afterEach(() => {
    cleanup()
    globalThis.MessageChannel = originalMessageChannel
  })

  it("defaults to Source without mounting plugins, supports opt-in selection with read-only snapshot, exposes bare fileName only, and preserves unsaved Monaco edits", async () => {
    let plugins: InstalledPlugin[] = [makeCsvViewerPlugin()]
    const htmlFetches: string[] = []
    const host = makeMockTransport({
      getPlugins: () => plugins,
      onHtmlFetch: (id) => htmlFetches.push(id),
    })
    mocks.transport = host.transport

    const dirtyCsv = makeFileTab({
      id: "file:/secret/workspace/REPORTS.CSV",
      title: "REPORTS.CSV",
      path: "/secret/workspace/REPORTS.CSV",
      content: "name,score\nalice,99\n",
      savedContent: "name,score\nalice,42\n",
      isDirty: true,
    })
    mocks.activeFileTab = dirtyCsv
    mocks.fileTabs = [dirtyCsv]

    const view = renderFileColumn("es")

    // Default view MUST be Monaco Source — never auto-switch or fetch plugin HTML.
    expect(screen.getByTestId("monaco-editor")).toHaveAttribute(
      "data-value",
      "name,score\nalice,99\n"
    )
    expect(screen.queryByTitle("Vista de tabla")).toBeNull()
    expect(htmlFetches).toEqual([])

    // Localized file view selector appears once catalog loads.
    const selector = await screen.findByRole("button", {
      name: esMessages.Folder.fileWorkspace.fileView,
    })
    expect(selector).toHaveTextContent(esMessages.Folder.fileWorkspace.source)

    // Explicitly select the localized CSV plugin panel.
    await openDropdown(selector)
    const pluginOption = screen.getByRole("menuitemradio", {
      name: "Vista de tabla",
    })
    await act(async () => {
      pluginOption.click()
    })

    // Surface mounts with sandboxed iframe and real MessagePort handshake.
    const iframe = (await screen.findByTitle(
      "Vista de tabla"
    )) as HTMLIFrameElement
    expect(iframe.tagName).toBe("IFRAME")
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts")
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer")
    expect(screen.queryByTestId("monaco-editor")).toBeNull()

    const session = await connectPluginIframe(iframe)
    expect(session.srcDoc).toContain("api.file = Object.freeze")
    expect(session.srcDoc).toContain("file.readText does not accept arguments")
    expect(session.srcDoc).not.toContain("api.composer =")
    expect(session.srcDoc).not.toContain("/secret/workspace")

    // Context exposes ONLY { type: "filePanel", id, fileName, locale } — no path or folderId!
    expect(session.context).toEqual({
      type: "filePanel",
      id: "table",
      fileName: "REPORTS.CSV",
      locale: "es",
    })
    expect(Object.keys(session.context).sort()).toEqual([
      "fileName",
      "id",
      "locale",
      "type",
    ])

    // readText() returns live unsaved text snapshot with zero implicit disk reads.
    const readOk = await session.sendOperation("file", { type: "readText" })
    expect(readOk).toEqual({
      id: 1,
      ok: true,
      value: { text: "name,score\nalice,99\n" },
    })
    expect(mocks.readFileForEditSpy).not.toHaveBeenCalled()

    // Unexpected arguments / path smuggling attempts are strictly rejected.
    const readWithArg = await session.sendOperation("file", {
      type: "readText",
      path: "/etc/passwd",
    })
    expect(readWithArg?.ok).toBe(false)
    expect(readWithArg?.error).toMatch(/arguments/i)

    // Oversized (> 64 KiB UTF-8, including multi-byte chars) content is rejected.
    const oversized = {
      ...dirtyCsv,
      content: "汉".repeat(21_846),
    }
    mocks.activeFileTab = oversized
    mocks.fileTabs = [oversized]
    view.rerender(
      <NextIntlClientProvider locale="es" messages={esMessages}>
        <div className="flex h-[480px] w-[320px] flex-col">
          <FileWorkspaceHeader />
          <div className="flex-1 min-h-0">
            <FileWorkspacePanel />
          </div>
        </div>
      </NextIntlClientProvider>
    )
    const readOversized = await session.sendOperation("file", {
      type: "readText",
    })
    expect(readOversized?.ok).toBe(false)
    expect(readOversized?.error).toMatch(/64 KiB/i)

    // Loading state during background refresh rejects readText cleanly.
    const refreshing = {
      ...dirtyCsv,
      loading: true,
    }
    mocks.activeFileTab = refreshing
    mocks.fileTabs = [refreshing]
    view.rerender(
      <NextIntlClientProvider locale="es" messages={esMessages}>
        <div className="flex h-[480px] w-[320px] flex-col">
          <FileWorkspaceHeader />
          <div className="flex-1 min-h-0">
            <FileWorkspacePanel />
          </div>
        </div>
      </NextIntlClientProvider>
    )
    const readWhileLoading = await session.sendOperation("file", {
      type: "readText",
    })
    expect(readWhileLoading?.ok).toBe(false)
    expect(readWhileLoading?.error).toMatch(/loading/i)

    // 0-byte empty text file returns { text: "" } cleanly.
    const emptyCsv = {
      ...dirtyCsv,
      content: "",
      savedContent: "",
      isDirty: false,
    }
    mocks.activeFileTab = emptyCsv
    mocks.fileTabs = [emptyCsv]
    view.rerender(
      <NextIntlClientProvider locale="es" messages={esMessages}>
        <div className="flex h-[480px] w-[320px] flex-col">
          <FileWorkspaceHeader />
          <div className="flex-1 min-h-0">
            <FileWorkspacePanel />
          </div>
        </div>
      </NextIntlClientProvider>
    )
    const readEmpty = await session.sendOperation("file", { type: "readText" })
    expect(readEmpty).toEqual({
      id: 5,
      ok: true,
      value: { text: "" },
    })

    // Restore dirty tab and return to Source — unsaved edits & dirty badge are intact!
    mocks.activeFileTab = dirtyCsv
    mocks.fileTabs = [dirtyCsv]
    view.rerender(
      <NextIntlClientProvider locale="es" messages={esMessages}>
        <div className="flex h-[480px] w-[320px] flex-col">
          <FileWorkspaceHeader />
          <div className="flex-1 min-h-0">
            <FileWorkspacePanel />
          </div>
        </div>
      </NextIntlClientProvider>
    )
    await openDropdown(
      screen.getByRole("button", {
        name: esMessages.Folder.fileWorkspace.fileView,
      })
    )
    await act(async () => {
      screen
        .getByRole("menuitemradio", {
          name: esMessages.Folder.fileWorkspace.source,
        })
        .click()
    })

    expect(screen.queryByTitle("Vista de tabla")).toBeNull()
    expect(session.port.peer.closed).toBe(true)
    expect(screen.getByTestId("monaco-editor")).toHaveAttribute(
      "data-value",
      "name,score\nalice,99\n"
    )
    expect(screen.getByTestId("file-breadcrumb")).toHaveTextContent(
      "REPORTS.CSV *"
    )

    // Silence unused mutation warning if plugins is mutated in sibling tests.
    plugins = []
    expect(plugins).toHaveLength(0)
  })

  it("never exposes window.codeg.file or accepts file operations on non-filePanel surfaces", async () => {
    const host = makeMockTransport({
      getPlugins: () => [makeCsvViewerPlugin()],
    })
    mocks.transport = host.transport

    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <HostPluginSurface
          pluginId="codeg.csv-viewer"
          title="Non File Surface"
          context={{ type: "sidebarView", id: "side" }}
          onFileReadText={() => ({ text: "should never leak" })}
        />
      </NextIntlClientProvider>
    )

    const iframe = (await screen.findByTitle(
      "Non File Surface"
    )) as HTMLIFrameElement
    const session = await connectPluginIframe(iframe)
    expect(session.srcDoc).not.toContain("api.file =")
    const forbidden = await session.sendOperation("file", { type: "readText" })
    expect(forbidden?.ok).toBe(false)
    expect(forbidden?.error).toMatch(/unavailable/i)
  })

  it("preserves built-in Markdown/HTML Preview state across plugin panel round-trips and hides hoisted HTML controls while plugin view is active", async () => {
    const host = makeMockTransport({
      getPlugins: () => [makeCsvViewerPlugin()],
    })
    mocks.transport = host.transport

    const htmlTab = makeFileTab({
      id: "file:/repo/index.html",
      title: "index.html",
      path: "/repo/index.html",
      language: "html",
      content: "<h1>Hello</h1>",
      savedContent: "<h1>Hello</h1>",
    })
    mocks.activeFileTab = htmlTab
    mocks.fileTabs = [htmlTab]
    mocks.previewFileTabIds = new Set([htmlTab.id])

    const view = renderFileColumn("en")

    expect(screen.getByTestId("html-preview")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Enable scripts" })
    ).toBeInTheDocument()

    const selector = await screen.findByRole("button", { name: "File view" })
    expect(selector).toHaveTextContent("Preview")

    // Switch to plugin panel — HTML preview unmounts & hoisted controls disappear,
    // while previewFileTabIds stays intact.
    await openDropdown(selector)
    await act(async () => {
      screen.getByRole("menuitemradio", { name: "Doc Outline" }).click()
    })

    await screen.findByTitle("Doc Outline")
    expect(screen.queryByTestId("html-preview")).toBeNull()
    expect(screen.queryByRole("button", { name: "Enable scripts" })).toBeNull()
    expect(mocks.previewFileTabIds.has(htmlTab.id)).toBe(true)

    // Return to Preview — does NOT toggle previewFileTabIds and restores HTML preview!
    await openDropdown(screen.getByRole("button", { name: "File view" }))
    await act(async () => {
      screen.getByRole("menuitemradio", { name: "Preview" }).click()
    })
    expect(mocks.toggleFileTabPreview).not.toHaveBeenCalled()
    expect(screen.getByTestId("html-preview")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Enable scripts" })
    ).toBeInTheDocument()

    // Verify Markdown preview also stays intact when returning from plugin panel.
    const mdTab = makeFileTab({
      id: "file:/repo/README.md",
      title: "README.md",
      path: "/repo/README.md",
      language: "markdown",
      content: "# Heading",
      savedContent: "# Heading",
    })
    mocks.activeFileTab = mdTab
    mocks.fileTabs = [mdTab]
    mocks.previewFileTabIds = new Set([mdTab.id])
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <div className="flex h-[480px] w-[320px] flex-col">
          <FileWorkspaceHeader />
          <div className="flex-1 min-h-0">
            <FileWorkspacePanel />
          </div>
        </div>
      </NextIntlClientProvider>
    )
    expect(screen.getByTestId("markdown-preview")).toBeInTheDocument()
    await openDropdown(await screen.findByRole("button", { name: "File view" }))
    await act(async () => {
      screen.getByRole("menuitemradio", { name: "Doc Outline" }).click()
    })
    await screen.findByTitle("Doc Outline")
    expect(screen.queryByTestId("markdown-preview")).toBeNull()
    await openDropdown(screen.getByRole("button", { name: "File view" }))
    await act(async () => {
      screen.getByRole("menuitemradio", { name: "Preview" }).click()
    })
    expect(screen.getByTestId("markdown-preview")).toBeInTheDocument()
  })

  it("never offers file panels for binary (image/svg/pdf/office), diff/conflict, browser, cold-loading, or load-failed tabs", async () => {
    const allExtPlugin = makeCsvViewerPlugin({
      filePanels: [
        {
          id: "any",
          title: "Any Viewer",
          extensions: ["png", "svg", "pdf", "docx", "csv"],
        },
      ],
    })
    const host = makeMockTransport({ getPlugins: () => [allExtPlugin] })
    mocks.transport = host.transport

    const ineligibleTabs: FileWorkspaceTab[] = [
      makeFileTab({
        id: "file:/repo/logo.svg",
        title: "logo.svg",
        path: "/repo/logo.svg",
        language: "image",
        content: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
        readonly: true,
      }),
      makeFileTab({
        id: "file:/repo/pic.png",
        title: "pic.png",
        path: "/repo/pic.png",
        language: "image",
        content: "data:image/png;base64,AAAA",
        readonly: true,
      }),
      makeFileTab({
        id: "file:/repo/doc.pdf",
        title: "doc.pdf",
        path: "/repo/doc.pdf",
        language: "pdf",
        content: "data:application/pdf;base64,JVBERi0=",
        readonly: true,
      }),
      makeFileTab({
        id: "file:/repo/spec.docx",
        title: "spec.docx",
        path: "/repo/spec.docx",
        language: "office",
        content: "",
        readonly: true,
      }),
      makeFileTab({
        id: "diff:external-conflict:%2Frepo%2Fdata.csv",
        kind: "rich-diff",
        title: "data.csv (conflict)",
        path: "/repo/data.csv",
        language: "plaintext",
        originalContent: "a",
        modifiedContent: "b",
      }),
      makeFileTab({
        id: "file:/repo/cold.csv",
        title: "cold.csv",
        path: "/repo/cold.csv",
        content: "",
        savedContent: "",
        etag: null,
        mtimeMs: null,
        loading: true,
      }),
      makeFileTab({
        id: "file:/repo/broken.csv",
        title: "broken.csv",
        path: "/repo/broken.csv",
        content: "Unable to load content: Binary file",
        savedContent: "",
        etag: null,
        mtimeMs: null,
        saveState: "error",
        saveError: "Binary file",
        loadError: "Binary file",
        loading: false,
      }),
    ]

    for (const tab of ineligibleTabs) {
      mocks.activeFileTab = tab
      mocks.fileTabs = [tab]
      const { unmount } = renderFileColumn("en")
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
      expect(screen.queryByRole("button", { name: "File view" })).toBeNull()
      unmount()
    }
  })

  it("unmounts and invalidates ports on file switch (including same basename), plugin disable/withdraw, remote boot gating, transport replacement, and pendingFileReveal", async () => {
    let remotePlugins: InstalledPlugin[] = [makeCsvViewerPlugin()]
    const localHost = makeMockTransport({
      getPlugins: () => [makeCsvViewerPlugin()],
    })
    const remoteHostA = makeMockTransport({
      getPlugins: () => remotePlugins,
    })
    const remoteHostB = makeMockTransport({
      getPlugins: () => remotePlugins,
    })

    // 1) Remote boot gating: URL targets remoteConnectionId=9 while local transport is active.
    window.history.replaceState({}, "", "/workspace?remoteConnectionId=9")
    mocks.activeRemoteId = null
    mocks.transport = localHost.transport

    const fileA = makeFileTab({
      id: "file:/repo/a/data.csv",
      title: "data.csv",
      path: "/repo/a/data.csv",
      content: "col\nfrom-a\n",
    })
    const fileB = makeFileTab({
      id: "file:/repo/b/data.csv",
      title: "data.csv",
      path: "/repo/b/data.csv",
      content: "col\nfrom-b\n",
    })
    mocks.activeFileTab = fileA
    mocks.fileTabs = [fileA, fileB]

    const view = renderFileColumn("en")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(localHost.calls).toEqual([])
    expect(screen.queryByRole("button", { name: "File view" })).toBeNull()

    // Attach remote transport for connection 9 -> selector appears, still defaults to Source.
    await act(async () => {
      mocks.activeRemoteId = 9
      mocks.transport = remoteHostA.transport
      notifyTransportChange()
    })
    const selector = await screen.findByRole("button", { name: "File view" })
    expect(screen.getByTestId("monaco-editor")).toBeInTheDocument()

    // Select plugin panel on file A.
    await openDropdown(selector)
    await act(async () => {
      screen.getByRole("menuitemradio", { name: "Table View" }).click()
    })
    const iframeA = (await screen.findByTitle(
      "Table View"
    )) as HTMLIFrameElement
    const sessionA = await connectPluginIframe(iframeA)
    expect(await sessionA.sendOperation("file", { type: "readText" })).toEqual({
      id: 1,
      ok: true,
      value: { text: "col\nfrom-a\n" },
    })

    // 2) Switch to file B with IDENTICAL basename "data.csv":
    //    old iframe unmounts, old port closes, file B opens in Source (not auto-mounted).
    mocks.activeFileTab = fileB
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <div className="flex h-[480px] w-[320px] flex-col">
          <FileWorkspaceHeader />
          <div className="flex-1 min-h-0">
            <FileWorkspacePanel />
          </div>
        </div>
      </NextIntlClientProvider>
    )
    expect(screen.queryByTitle("Table View")).toBeNull()
    expect(sessionA.port.peer.closed).toBe(true)
    expect(
      await sessionA.sendOperation("file", { type: "readText" })
    ).toBeUndefined()
    expect(screen.getByTestId("monaco-editor")).toHaveAttribute(
      "data-value",
      "col\nfrom-b\n"
    )

    // Switching back to file A also stays on Source (never auto-remounts).
    mocks.activeFileTab = fileA
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <div className="flex h-[480px] w-[320px] flex-col">
          <FileWorkspaceHeader />
          <div className="flex-1 min-h-0">
            <FileWorkspacePanel />
          </div>
        </div>
      </NextIntlClientProvider>
    )
    expect(screen.queryByTitle("Table View")).toBeNull()
    expect(screen.getByTestId("monaco-editor")).toBeInTheDocument()

    // 3) Select plugin panel again, then replace Transport under the SAME remoteConnectionId=9 ->
    //    immediately unmounts iframe and falls back to Source!
    await openDropdown(screen.getByRole("button", { name: "File view" }))
    await act(async () => {
      screen.getByRole("menuitemradio", { name: "Table View" }).click()
    })
    const iframeBeforeSwap = (await screen.findByTitle(
      "Table View"
    )) as HTMLIFrameElement
    const sessionBeforeSwap = await connectPluginIframe(iframeBeforeSwap)

    await act(async () => {
      mocks.transport = remoteHostB.transport
      notifyTransportChange()
    })
    await waitFor(() => {
      expect(screen.queryByTitle("Table View")).toBeNull()
    })
    expect(sessionBeforeSwap.port.peer.closed).toBe(true)
    expect(screen.getByTestId("monaco-editor")).toBeInTheDocument()

    // 4) Select again on remoteHostB, then disable plugin -> immediate unmount;
    //    re-enabling later must NOT auto-switch back!
    await openDropdown(await screen.findByRole("button", { name: "File view" }))
    await act(async () => {
      screen.getByRole("menuitemradio", { name: "Table View" }).click()
    })
    await screen.findByTitle("Table View")

    await act(async () => {
      remotePlugins = [makeCsvViewerPlugin({ enabled: false })]
      remoteHostB.emit("host-plugins://changed", {})
    })
    await waitFor(() => {
      expect(screen.queryByTitle("Table View")).toBeNull()
      expect(screen.queryByRole("button", { name: "File view" })).toBeNull()
    })
    expect(screen.getByTestId("monaco-editor")).toBeInTheDocument()

    await act(async () => {
      remotePlugins = [makeCsvViewerPlugin({ enabled: true })]
      remoteHostB.emit("host-plugins://changed", {})
    })
    await screen.findByRole("button", { name: "File view" })
    expect(screen.queryByTitle("Table View")).toBeNull()
    expect(screen.getByTestId("monaco-editor")).toBeInTheDocument()

    // 5) Select again, then withdraw client.entry -> immediate unmount!
    await openDropdown(screen.getByRole("button", { name: "File view" }))
    await act(async () => {
      screen.getByRole("menuitemradio", { name: "Table View" }).click()
    })
    await screen.findByTitle("Table View")

    await act(async () => {
      remotePlugins = [makeCsvViewerPlugin({ clientEntry: null })]
      remoteHostB.emit("host-plugins://changed", {})
    })
    await waitFor(() => {
      expect(screen.queryByTitle("Table View")).toBeNull()
    })

    // 5b) Restore client.entry, select again, then withdraw filePanels -> immediate unmount!
    await act(async () => {
      remotePlugins = [makeCsvViewerPlugin()]
      remoteHostB.emit("host-plugins://changed", {})
    })
    await openDropdown(await screen.findByRole("button", { name: "File view" }))
    await act(async () => {
      screen.getByRole("menuitemradio", { name: "Table View" }).click()
    })
    await screen.findByTitle("Table View")

    await act(async () => {
      remotePlugins = [makeCsvViewerPlugin({ filePanels: [] })]
      remoteHostB.emit("host-plugins://changed", {})
    })
    await waitFor(() => {
      expect(screen.queryByTitle("Table View")).toBeNull()
    })

    // 6) Restore plugin, select panel, and trigger pendingFileReveal -> exits back to Monaco!
    await act(async () => {
      remotePlugins = [makeCsvViewerPlugin()]
      remoteHostB.emit("host-plugins://changed", {})
    })
    await openDropdown(await screen.findByRole("button", { name: "File view" }))
    await act(async () => {
      screen.getByRole("menuitemradio", { name: "Table View" }).click()
    })
    await screen.findByTitle("Table View")

    mocks.pendingFileReveal = {
      requestId: 1,
      path: fileA.path!,
      line: 2,
    }
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <div className="flex h-[480px] w-[320px] flex-col">
          <FileWorkspaceHeader />
          <div className="flex-1 min-h-0">
            <FileWorkspacePanel />
          </div>
        </div>
      </NextIntlClientProvider>
    )
    await waitFor(() => {
      expect(screen.queryByTitle("Table View")).toBeNull()
      expect(screen.getByTestId("monaco-editor")).toBeInTheDocument()
    })
  })

  it("clears selection on real mobile unmount (Back leaving files pane) so reopening the exact same file restores default Source", async () => {
    const jsonOutlinePlugin = makeCsvViewerPlugin({
      filePanels: [
        {
          id: "json-outline",
          title: "JSON Outline",
          extensions: ["json"],
        },
      ],
    })
    const host = makeMockTransport({
      getPlugins: () => [jsonOutlinePlugin],
    })
    mocks.transport = host.transport

    const smokeJson = makeFileTab({
      id: "file:/repo/smoke.json",
      title: "smoke.json",
      path: "/repo/smoke.json",
      language: "json",
      content: '{"ok":true}\n',
      savedContent: '{"ok":true}\n',
    })
    mocks.activeFileTab = smokeJson
    mocks.fileTabs = [smokeJson]

    const renderMobile = (showConversation: boolean) => (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <div className="h-[640px] w-[390px]">
          <MobileWorkspacePanes
            showConversation={showConversation}
            files={
              <>
                <FileWorkspaceHeader />
                <div className="flex-1 min-h-0">
                  <FileWorkspacePanel />
                </div>
              </>
            }
          >
            <div data-testid="mobile-conversation" />
          </MobileWorkspacePanes>
        </div>
      </NextIntlClientProvider>
    )

    const view = render(renderMobile(false))
    expect(screen.getByTestId("monaco-editor")).toBeInTheDocument()

    // Explicitly select JSON Outline on 390px mobile.
    await openDropdown(await screen.findByRole("button", { name: "File view" }))
    await act(async () => {
      screen.getByRole("menuitemradio", { name: "JSON Outline" }).click()
    })
    const iframe = (await screen.findByTitle(
      "JSON Outline"
    )) as HTMLIFrameElement
    const session = await connectPluginIframe(iframe)
    expect(await session.sendOperation("file", { type: "readText" })).toEqual({
      id: 1,
      ok: true,
      value: { text: '{"ok":true}\n' },
    })

    // Simulate mobile Back leaving the files pane (unmounts FileWorkspaceHeader + FileWorkspacePanel).
    view.rerender(renderMobile(true))
    expect(screen.queryByTitle("JSON Outline")).toBeNull()
    expect(screen.queryByTestId("monaco-editor")).toBeNull()
    expect(session.port.peer.closed).toBe(true)
    expect(
      await session.sendOperation("file", { type: "readText" })
    ).toBeUndefined()

    // Reopen the exact same smoke.json from Files: MUST restore default Monaco Source,
    // NEVER auto-remount JSON Outline.
    view.rerender(renderMobile(false))
    expect(screen.getByTestId("monaco-editor")).toHaveAttribute(
      "data-value",
      '{"ok":true}\n'
    )
    expect(screen.queryByTitle("JSON Outline")).toBeNull()

    // User can explicitly opt back into JSON Outline afterward.
    await openDropdown(await screen.findByRole("button", { name: "File view" }))
    await act(async () => {
      screen.getByRole("menuitemradio", { name: "JSON Outline" }).click()
    })
    const iframeAgain = (await screen.findByTitle(
      "JSON Outline"
    )) as HTMLIFrameElement
    const sessionAgain = await connectPluginIframe(iframeAgain)
    expect(
      await sessionAgain.sendOperation("file", { type: "readText" })
    ).toEqual({
      id: 1,
      ok: true,
      value: { text: '{"ok":true}\n' },
    })
  })

  it("withdraws plugin iframe and file.readText when OverlayHostHiddenProvider hides a kept-mounted file column, restoring built-in Source or native Preview on return", async () => {
    const host = makeMockTransport({
      getPlugins: () => [
        makeCsvViewerPlugin({
          filePanels: [
            {
              id: "json-outline",
              title: "JSON Outline",
              extensions: ["json"],
            },
            {
              id: "md-outline",
              title: "Markdown Outline",
              extensions: ["md"],
            },
          ],
        }),
      ],
    })
    mocks.transport = host.transport

    const renderDesktopColumn = (hidden: boolean) => (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <OverlayHostHiddenProvider hidden={hidden}>
          <div className="flex h-[480px] w-[420px] flex-col">
            <FileWorkspaceHeader />
            <div className="flex-1 min-h-0">
              <FileWorkspacePanel />
            </div>
          </div>
        </OverlayHostHiddenProvider>
      </NextIntlClientProvider>
    )

    // 1) Source file (smoke.json): hide behind maximized conversation / workbench route ->
    //    unmounts iframe & closes port immediately, returning restores Monaco Source.
    const smokeJson = makeFileTab({
      id: "file:/repo/smoke.json",
      title: "smoke.json",
      path: "/repo/smoke.json",
      language: "json",
      content: '{"hello":"desktop"}\n',
      savedContent: '{"hello":"desktop"}\n',
    })
    mocks.activeFileTab = smokeJson
    mocks.fileTabs = [smokeJson]

    const view = render(renderDesktopColumn(false))
    await openDropdown(await screen.findByRole("button", { name: "File view" }))
    await act(async () => {
      screen.getByRole("menuitemradio", { name: "JSON Outline" }).click()
    })
    const jsonFrame = (await screen.findByTitle(
      "JSON Outline"
    )) as HTMLIFrameElement
    const jsonSession = await connectPluginIframe(jsonFrame)
    expect(
      await jsonSession.sendOperation("file", { type: "readText" })
    ).toEqual({
      id: 1,
      ok: true,
      value: { text: '{"hello":"desktop"}\n' },
    })

    // Hide column via OverlayHostHiddenProvider while keeping FileWorkspacePanel mounted!
    view.rerender(renderDesktopColumn(true))
    expect(screen.queryByTitle("JSON Outline")).toBeNull()
    expect(jsonSession.port.peer.closed).toBe(true)
    expect(
      await jsonSession.sendOperation("file", { type: "readText" })
    ).toBeUndefined()

    // Return to visible files column -> stays on built-in Monaco Source (no auto-remount).
    view.rerender(renderDesktopColumn(false))
    expect(screen.getByTestId("monaco-editor")).toHaveAttribute(
      "data-value",
      '{"hello":"desktop"}\n'
    )
    expect(screen.queryByTitle("JSON Outline")).toBeNull()

    // 2) Native Preview file (README.md): hide while plugin panel is open ->
    //    unmounts iframe, returning restores native Markdown Preview (preserving previewFileTabIds).
    const readmeMd = makeFileTab({
      id: "file:/repo/README.md",
      title: "README.md",
      path: "/repo/README.md",
      language: "markdown",
      content: "# Native Preview\n",
      savedContent: "# Native Preview\n",
    })
    mocks.activeFileTab = readmeMd
    mocks.fileTabs = [readmeMd]
    mocks.previewFileTabIds = new Set([readmeMd.id])
    view.rerender(renderDesktopColumn(false))
    expect(screen.getByTestId("markdown-preview")).toBeInTheDocument()

    await openDropdown(await screen.findByRole("button", { name: "File view" }))
    await act(async () => {
      screen.getByRole("menuitemradio", { name: "Markdown Outline" }).click()
    })
    const mdFrame = (await screen.findByTitle(
      "Markdown Outline"
    )) as HTMLIFrameElement
    const mdSession = await connectPluginIframe(mdFrame)

    view.rerender(renderDesktopColumn(true))
    expect(screen.queryByTitle("Markdown Outline")).toBeNull()
    expect(mdSession.port.peer.closed).toBe(true)

    view.rerender(renderDesktopColumn(false))
    expect(screen.queryByTitle("Markdown Outline")).toBeNull()
    expect(screen.getByTestId("markdown-preview")).toBeInTheDocument()
    expect(mocks.previewFileTabIds.has(readmeMd.id)).toBe(true)
  })
})
