import { type ReactElement, useState } from "react"
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import zhCNMessages from "@/i18n/messages/zh-CN.json"
import type { InstalledPlugin, NewWorkspacePatch } from "@/lib/host-plugins"
import { applyNewWorkspacePatch } from "@/lib/host-plugins"
import type { FolderDetail } from "@/lib/types"
import type { Transport } from "@/lib/transport"

const h = vi.hoisted(() => ({
  transport: null as Transport | null,
  activeRemoteConnectionId: null as number | null,
  transportListeners: new Set<() => void>(),
  openFolder: vi.fn(),
  openWorktreeFolder: vi.fn(async (path: string) => ({
    id: 99,
    name: "wt",
    path,
    git_branch: null,
    default_agent_type: null,
    last_opened_at: "2026-11-22T00:00:00Z",
    sort_order: 0,
    color: "inherit",
    parent_id: 7,
    kind: "worktree",
    alias: null,
    group_id: null,
  })),
  gitWorktreeAdd: vi.fn(async () => undefined),
  gitListAllBranches: vi.fn(async () => ({
    local: ["main"],
    remote: [],
    worktree_branches: [],
    main_worktree_branch: "main",
  })),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock("@/lib/transport", () => ({
  getActiveRemoteConnectionId: () => h.activeRemoteConnectionId,
  subscribeTransportChange: (listener: () => void) => {
    h.transportListeners.add(listener)
    return () => {
      h.transportListeners.delete(listener)
    }
  },
  isDesktop: () => false,
  isRemoteDesktopMode: () => false,
  getTransport: () => {
    if (!h.transport) throw new Error("mock transport not configured")
    return h.transport
  },
}))

vi.mock("sonner", () => ({
  toast: {
    error: h.toastError,
    success: h.toastSuccess,
    warning: vi.fn(),
    info: vi.fn(),
  },
}))

vi.mock("@/lib/platform", () => ({
  isDesktop: () => false,
  openFileDialog: vi.fn(),
  subscribe: vi.fn(async () => () => {}),
  emitEvent: vi.fn(),
}))

vi.mock("@/lib/api", () => ({
  getHomeDirectory: vi.fn(async () => "/home/demo"),
  listDirectoryEntries: vi.fn(async () => []),
  createDirectory: vi.fn(),
  listFolderLinks: vi.fn(async () => []),
  previewFolderLinks: vi.fn(async () => []),
  createFolderLinks: vi.fn(async () => []),
  renameFolderLink: vi.fn(),
  repairFolderLink: vi.fn(),
  removeFolderLink: vi.fn(),
  gitInit: vi.fn(),
  gitNewBranch: vi.fn(),
  gitWorktreeAdd: h.gitWorktreeAdd,
  gitListAllBranches: h.gitListAllBranches,
  gitMerge: vi.fn(),
  gitRebase: vi.fn(),
  gitDeleteBranch: vi.fn(),
  gitDeleteRemoteBranch: vi.fn(),
  gitRemoveWorktree: vi.fn(),
  getFolder: vi.fn(),
  getGitHead: vi.fn(async () => "main"),
  listAllConversations: vi.fn(async () => []),
  listAllFolderDetails: vi.fn(async () => []),
  listFolderGroups: vi.fn(async () => []),
  listOpenFolderDetails: vi.fn(async () => []),
  openFolder: h.openFolder,
  openFolderById: vi.fn(),
  openWorktreeFolder: h.openWorktreeFolder,
  removeFolderFromWorkspace: vi.fn(),
  applySidebarLayout: vi.fn(),
  createFolderGroup: vi.fn(),
  updateFolderGroup: vi.fn(),
  deleteFolderGroup: vi.fn(),
  setFolderGroup: vi.fn(),
}))

vi.mock("@/stores/app-workspace-store", () => {
  const branches = new Map<number, string | null>([[7, "main"]])
  const gitHeads = new Map<
    number,
    { is_repo: boolean; detached: boolean; branch: string | null }
  >([[7, { is_repo: true, detached: false, branch: "main" }]])
  const storeState = {
    openFolder: h.openFolder,
    openWorktreeFolder: h.openWorktreeFolder,
    refreshFolder: vi.fn(async () => undefined),
    ensureGitHead: vi.fn(),
    branches,
    gitHeads,
    folders: [],
    allFolders: [],
  }
  return {
    useAppWorkspaceStore: (selector: (s: typeof storeState) => unknown) =>
      selector(storeState),
  }
})

vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({ openNewConversationTab: vi.fn() }),
}))

vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ openConversations: vi.fn() }),
}))

vi.mock("@/contexts/git-credential-context", () => ({
  useGitCredential: () => ({
    withCredentialRetry: async (fn: () => Promise<unknown>) => fn(),
  }),
}))

vi.mock("@/hooks/use-switch-to-branch", () => ({
  useSwitchToBranch: () => vi.fn(),
}))

vi.mock("@/hooks/use-appearance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-appearance")>()),
  useZoomLevel: () => ({ zoomLevel: 100, setZoomLevel: () => {} }),
}))

vi.mock("@/hooks/use-git-quick-actions", () => ({
  useGitQuickActions: () => ({
    running: false,
    runGitTask: async (_label: string, fn: () => Promise<void>) => {
      await fn()
    },
    pull: vi.fn(),
    fetchAll: vi.fn(),
    updateBranch: vi.fn(),
    openPullDialog: vi.fn(),
    openPushDialog: vi.fn(),
    openCommitDialog: vi.fn(),
    openStashDialog: vi.fn(),
    dialogs: null,
  }),
}))

import { BranchDropdown } from "@/components/layout/branch-dropdown"
import { WorkspaceFolderDialog } from "@/components/layout/workspace-folder-dialog"
import {
  PluginNewWorkspaceItems,
  type PluginMetadataMap,
} from "./plugin-new-workspace-items"

const MESSAGES = {
  en: enMessages,
  "zh-CN": zhCNMessages,
} as const

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeAllControlsPlugin(enabled = true): InstalledPlugin {
  return {
    enabled,
    manifest: {
      id: "codeg.new-workspace-issues",
      name: "New Workspace Issues",
      nameTranslations: { "zh-CN": "新工作区工单" },
      version: "1.0.0",
      server: {
        entry: "issues.mjs",
        methods: [
          "search-issues",
          "load-templates",
          "on-draft-toggle",
          "suggest-workspace",
        ],
      },
      contributes: {
        workspacePanels: [],
        commands: [],
        hooks: [],
        newWorkspaceItems: [
          {
            id: "issue",
            title: "Issue",
            titleTranslations: { "zh-CN": "工单" },
            description: "Use an issue to suggest a branch name.",
            control: {
              kind: "combobox",
              searchMethod: "search-issues",
              placeholder: "Search by issue ID or title",
            },
          },
          {
            id: "template",
            title: "Template",
            control: {
              kind: "select",
              optionsMethod: "load-templates",
              placeholder: "Choose template",
            },
          },
          {
            id: "draft",
            title: "Mark as draft",
            target: "worktree",
            control: {
              kind: "toggle",
              defaultValue: false,
              onChangeMethod: "on-draft-toggle",
              enabledPatch: {
                metadata: { "issues.draft": true, source: "static" },
              },
              disabledPatch: {
                metadata: { "issues.draft": null, source: null },
              },
            },
          },
          {
            id: "autofill",
            title: "Suggest path",
            control: {
              kind: "action",
              method: "suggest-workspace",
            },
          },
        ],
      },
    },
  }
}

function createMockTransport(options?: {
  plugins?: InstalledPlugin[]
  onCall?: (params: {
    pluginId: string
    method: string
    input: Record<string, unknown>
  }) => unknown | Promise<unknown>
}) {
  let plugins = options?.plugins ?? []
  const subscribers = new Map<string, Set<(payload: unknown) => void>>()
  const calls: Array<{ method: string; params: unknown }> = []

  const transport: Transport = {
    isDesktop: () => false,
    call: vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params })
      if (method === "host_plugins_list") return plugins
      if (method === "host_plugins_call" && options?.onCall) {
        return options.onCall(
          params as {
            pluginId: string
            method: string
            input: Record<string, unknown>
          }
        )
      }
      return null
    }) as Transport["call"],
    subscribe: vi.fn(async (event: string, cb: (payload: unknown) => void) => {
      const set = subscribers.get(event) ?? new Set()
      set.add(cb)
      subscribers.set(event, set)
      return () => {
        set.delete(cb)
      }
    }) as Transport["subscribe"],
  }

  return {
    transport,
    calls,
    setPlugins(next: InstalledPlugin[]) {
      plugins = next
      for (const cb of subscribers.get("host-plugins://changed") ?? []) {
        cb(undefined)
      }
    },
  }
}

function notifyTransportChange() {
  for (const listener of h.transportListeners) {
    listener()
  }
}

function renderWithIntl(
  ui: ReactElement,
  locale: keyof typeof MESSAGES = "en"
) {
  return render(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
      {ui}
    </NextIntlClientProvider>
  )
}

function Harness({
  target,
  resetKey,
}: {
  target: "workspace" | "worktree"
  resetKey?: string
}) {
  const [branch, setBranch] = useState("main")
  const [rootPath, setRootPath] = useState("/repo/app")
  const [metadataByPlugin, setMetadataByPlugin] = useState<PluginMetadataMap>(
    {}
  )

  return (
    <div>
      <output data-testid="draft-branch">{branch}</output>
      <output data-testid="draft-root">{rootPath}</output>
      <PluginNewWorkspaceItems
        target={target}
        folderPath={rootPath || undefined}
        baseRef="main"
        branch={branch || undefined}
        metadataByPlugin={metadataByPlugin}
        resetKey={resetKey}
        onApplyPatch={(pluginId, patch: NewWorkspacePatch) => {
          if ("branch" in patch && patch.branch !== undefined) {
            setBranch(patch.branch ?? "")
          }
          if ("rootPath" in patch && patch.rootPath !== undefined) {
            setRootPath(patch.rootPath ?? "")
          }
          if (patch.metadata) {
            setMetadataByPlugin((prev) => {
              const next = applyNewWorkspacePatch(
                { metadata: prev[pluginId] ?? {} },
                { metadata: patch.metadata }
              )
              if (Object.keys(next.metadata).length === 0) {
                const rest = { ...prev }
                delete rest[pluginId]
                return rest
              }
              return { ...prev, [pluginId]: next.metadata }
            })
          }
        }}
        onPrunePlugins={(activeIds) => {
          setMetadataByPlugin((prev) => {
            let changed = false
            const next: PluginMetadataMap = {}
            for (const [id, value] of Object.entries(prev)) {
              if (activeIds.has(id)) next[id] = value
              else changed = true
            }
            return changed ? next : prev
          })
        }}
      />
    </div>
  )
}

describe("PluginNewWorkspaceItems & real form integrations", () => {
  beforeEach(() => {
    h.transport = null
    h.activeRemoteConnectionId = null
    h.transportListeners.clear()
    window.history.replaceState({}, "", "/")
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it("renders zero DOM when remote transport is booting or no matching items exist", async () => {
    window.history.replaceState({}, "", "/?remoteConnectionId=5")
    h.activeRemoteConnectionId = null
    const localMock = createMockTransport({
      plugins: [makeAllControlsPlugin(true)],
    })
    h.transport = localMock.transport

    renderWithIntl(<Harness target="worktree" />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(localMock.calls).toHaveLength(0)
    expect(
      document.querySelector('[data-slot="plugin-new-workspace-items"]')
    ).toBeNull()

    // Ready remote transport with disabled plugin -> still zero DOM
    const remoteMock = createMockTransport({
      plugins: [makeAllControlsPlugin(false)],
    })
    h.activeRemoteConnectionId = 5
    h.transport = remoteMock.transport
    act(() => {
      notifyTransportChange()
    })
    await waitFor(() => {
      expect(
        remoteMock.calls.some((c) => c.method === "host_plugins_list")
      ).toBe(true)
    })
    expect(
      document.querySelector('[data-slot="plugin-new-workspace-items"]')
    ).toBeNull()
  })

  it("supports combobox (debounce + stale race discard), dynamic select, toggle (static + dynamic override), action (re-entrancy guard), and plugin withdrawal", async () => {
    const search1 = createDeferred<unknown>()
    const search2 = createDeferred<unknown>()
    let searchCount = 0
    const actionDeferred = createDeferred<unknown>()
    const toggleDeferred = createDeferred<unknown>()

    const mock = createMockTransport({
      plugins: [makeAllControlsPlugin(true)],
      onCall: ({ method, input }) => {
        if (method === "search-issues") {
          searchCount += 1
          if (searchCount === 1) return search1.promise
          if (searchCount === 2) return search2.promise
          return {
            items: [
              {
                id: "demo-12",
                label: "DEMO-12 · Improve workspace search",
                patch: {
                  branch: "issue/demo-12-workspace-search",
                  metadata: { "issues.id": "DEMO-12" },
                },
              },
            ],
          }
        }
        if (method === "load-templates") {
          return {
            items: [
              {
                id: "clean",
                label: "Clean worktree",
                patch: { rootPath: "/repo/clean-wt" },
              },
            ],
          }
        }
        if (method === "on-draft-toggle") {
          expect(input.value).toBe(true)
          return toggleDeferred.promise
        }
        if (method === "suggest-workspace") {
          return actionDeferred.promise
        }
        return {}
      },
    })
    h.transport = mock.transport
    const user = userEvent.setup()

    renderWithIntl(<Harness target="worktree" />)

    // 1. Combobox: opens with query "", debounces typed query, discards out-of-order stale response
    const comboBtn = await screen.findByRole("button", {
      name: "Search by issue ID or title",
    })
    await user.click(comboBtn)
    await waitFor(() => {
      expect(searchCount).toBe(1)
    })

    const searchbox = screen.getByRole("searchbox", {
      name: "Search by issue ID or title",
    })
    await user.type(searchbox, "demo-12")
    await waitFor(() => {
      expect(searchCount).toBe(2)
    })

    // Resolve newer query (search2) FIRST
    await act(async () => {
      search2.resolve({
        items: [
          {
            id: "demo-12",
            label: "DEMO-12 · Improve workspace search",
            patch: {
              branch: "issue/demo-12-workspace-search",
              metadata: { "issues.id": "DEMO-12" },
            },
          },
        ],
      })
      await Promise.resolve()
    })
    expect(
      await screen.findByText("DEMO-12 · Improve workspace search")
    ).toBeInTheDocument()

    // Stale search1 resolves later -> MUST be discarded
    await act(async () => {
      search1.resolve({
        items: [{ id: "demo-99", label: "DEMO-99 · Stale result" }],
      })
      await Promise.resolve()
    })
    expect(screen.queryByText("DEMO-99 · Stale result")).not.toBeInTheDocument()

    // Selecting DEMO-12 applies branch + metadata preview
    await user.click(screen.getByText("DEMO-12 · Improve workspace search"))
    expect(screen.getByTestId("draft-branch")).toHaveTextContent(
      "issue/demo-12-workspace-search"
    )
    const metaBar = document.querySelector(
      '[data-slot="plugin-new-workspace-metadata"]'
    ) as HTMLElement
    expect(within(metaBar).getByText("issues.id:")).toBeInTheDocument()
    expect(within(metaBar).getByText("DEMO-12")).toBeInTheDocument()

    // 2. Dynamic select loads on open and applies patch
    await user.click(screen.getByRole("button", { name: "Choose template" }))
    await user.click(await screen.findByText("Clean worktree"))
    expect(screen.getByTestId("draft-root")).toHaveTextContent("/repo/clean-wt")

    // 3. Toggle applies static enabledPatch first, then dynamic onChangeMethod overrides conflicting metadata key
    const draftSwitch = screen.getByRole("switch", { name: "Mark as draft" })
    await user.click(draftSwitch)
    expect(within(metaBar).getByText("static")).toBeInTheDocument()

    await act(async () => {
      toggleDeferred.resolve({
        patch: { metadata: { source: "dynamic" } },
      })
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(within(metaBar).getByText("dynamic")).toBeInTheDocument()
    })
    expect(within(metaBar).queryByText("static")).not.toBeInTheDocument()

    // 4. Action disables while running (prevents re-entrancy) and applies returned patch
    const actionBtn = screen.getByRole("button", { name: "Suggest path" })
    await user.click(actionBtn)
    expect(actionBtn).toBeDisabled()
    await act(async () => {
      actionDeferred.resolve({ patch: { rootPath: "/repo/from-action" } })
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(screen.getByTestId("draft-root")).toHaveTextContent(
        "/repo/from-action"
      )
    })
    expect(actionBtn).not.toBeDisabled()

    // 5. Disabling plugin withdraws controls and prunes its metadata
    act(() => {
      mock.setPlugins([makeAllControlsPlugin(false)])
    })
    await waitFor(() => {
      expect(
        document.querySelector('[data-slot="plugin-new-workspace-items"]')
      ).toBeNull()
    })
  })

  it("integrates into WorkspaceFolderDialog (pick-root only, fills editable rootPath without auto-submitting)", async () => {
    let returnNull = false
    const mock = createMockTransport({
      plugins: [makeAllControlsPlugin(true)],
      onCall: ({ method }) => {
        if (method === "suggest-workspace") {
          return {
            patch: {
              rootPath: returnNull ? null : "/home/demo/suggested-project",
              metadata: { "issues.id": "DEMO-12" },
            },
          }
        }
        return { items: [] }
      },
    })
    h.transport = mock.transport
    const user = userEvent.setup()

    const { rerender } = renderWithIntl(
      <WorkspaceFolderDialog open onOpenChange={vi.fn()} />
    )

    // target="workspace" shows Suggest path, NOT worktree-only Mark as draft
    const suggestBtn = await screen.findByRole("button", {
      name: "Suggest path",
    })
    expect(
      screen.queryByRole("switch", { name: "Mark as draft" })
    ).not.toBeInTheDocument()

    await user.click(suggestBtn)
    await waitFor(() => {
      const input = screen.getByRole("textbox") as HTMLInputElement
      expect(input.value).toBe("/home/demo/suggested-project")
    })
    // Never auto-submits openFolder
    expect(h.openFolder).not.toHaveBeenCalled()

    // Explicit null clears rootPath
    returnNull = true
    await user.click(suggestBtn)
    await waitFor(() => {
      const input = screen.getByRole("textbox") as HTMLInputElement
      expect(input.value).toBe("")
    })

    // Manage mode (folder provided -> links view) does NOT render plugin new workspace items
    const existingFolder: FolderDetail = {
      id: 7,
      name: "root",
      path: "/home/demo/root",
      git_branch: null,
      default_agent_type: null,
      last_opened_at: "2026-11-22T00:00:00Z",
      sort_order: 0,
      color: "inherit",
      parent_id: null,
      kind: "regular",
      alias: null,
      group_id: null,
    }
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <WorkspaceFolderDialog
          open
          folder={existingFolder}
          onOpenChange={vi.fn()}
        />
      </NextIntlClientProvider>
    )
    expect(
      document.querySelector('[data-slot="plugin-new-workspace-items"]')
    ).toBeNull()
  })

  it("integrates into BranchDropdown New Worktree Dialog and submits via gitWorktreeAdd", async () => {
    const mock = createMockTransport({
      plugins: [makeAllControlsPlugin(true)],
      onCall: ({ method }) => {
        if (method === "search-issues") {
          return {
            items: [
              {
                id: "demo-12",
                label: "DEMO-12 · Improve workspace search",
                patch: {
                  branch: "issue/demo-12-workspace-search",
                  rootPath: "/repo/wt-demo-12",
                  baseRef: "release/v2",
                  metadata: { "issues.id": "DEMO-12" },
                },
              },
            ],
          }
        }
        return {}
      },
    })
    h.transport = mock.transport
    const user = userEvent.setup()

    const repoFolder: FolderDetail = {
      id: 7,
      name: "app",
      path: "/repo/app",
      git_branch: "main",
      default_agent_type: null,
      last_opened_at: "2026-11-22T00:00:00Z",
      sort_order: 0,
      color: "inherit",
      parent_id: null,
      kind: "regular",
      alias: null,
      group_id: null,
    }
    renderWithIntl(<BranchDropdown folder={repoFolder} isChatMode={false} />)

    // Open branch dropdown -> filter to New Worktree (virtua in jsdom renders index 0) -> click it
    await user.click(screen.getByRole("button", { name: /main/i }))
    const branchFilter = await screen.findByPlaceholderText(
      enMessages.Folder.branchDropdown.searchPlaceholder
    )
    await user.type(branchFilter, "New Worktree")
    await user.click(
      await screen.findByText(enMessages.Folder.branchDropdown.newWorktree)
    )

    const dialog = await screen.findByRole("dialog")
    // Both target="all" (Issue combobox) and target="worktree" (Mark as draft toggle) appear
    expect(
      await within(dialog).findByRole("switch", { name: "Mark as draft" })
    ).toBeInTheDocument()

    await user.click(
      within(dialog).getByRole("button", {
        name: "Search by issue ID or title",
      })
    )
    await user.click(
      await within(dialog).findByText("DEMO-12 · Improve workspace search")
    )

    expect(
      (
        within(dialog).getByLabelText(
          enMessages.Folder.branchDropdown.dialogs.branchNameLabel
        ) as HTMLInputElement
      ).value
    ).toBe("issue/demo-12-workspace-search")
    expect(
      (
        within(dialog).getByLabelText(
          enMessages.Folder.branchDropdown.dialogs.worktreePathLabel
        ) as HTMLInputElement
      ).value
    ).toBe("/repo/wt-demo-12")
    expect(within(dialog).getByText(/release\/v2/)).toBeInTheDocument()

    // Submit via existing gitWorktreeAdd
    await user.click(within(dialog).getByRole("button", { name: "Create" }))
    await waitFor(() => {
      expect(h.gitWorktreeAdd).toHaveBeenCalledWith(
        "/repo/app",
        "issue/demo-12-workspace-search",
        "/repo/wt-demo-12"
      )
    })
  })
})
