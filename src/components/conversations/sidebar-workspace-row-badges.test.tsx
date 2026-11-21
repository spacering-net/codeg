import { type ReactNode, useEffect } from "react"
import { act, render, waitFor, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SidebarConversationList } from "./sidebar-conversation-list"
import {
  MAX_WORKSPACE_ROW_BADGE_INPUT_BYTES,
  WORKSPACE_ROW_BADGE_BATCH_SIZE,
  WORKSPACE_ROW_BADGE_MAX_CONCURRENCY,
  type InstalledPlugin,
  type WorkspaceRowBadgeInput,
} from "@/lib/host-plugins"
import type { Transport } from "@/lib/transport"
import type { FolderDetail } from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import { resetFolderTabsStore } from "@/stores/folder-tabs-store"
import enMessages from "@/i18n/messages/en.json"
import esMessages from "@/i18n/messages/es.json"

type EventListener = (payload: unknown) => void

interface MockHostTransport {
  transport: Transport
  callMock: ReturnType<typeof vi.fn>
  emit: (event: string, payload?: unknown) => void
  triggerReconnect: () => void
  setCatalog: (plugins: InstalledPlugin[]) => void
  setBadgeHandler: (
    handler: (params: {
      pluginId: string
      method: string
      input: WorkspaceRowBadgeInput
    }) => unknown | Promise<unknown>
  ) => void
}

function createMockHostTransport(
  initialCatalog: InstalledPlugin[],
  initialHandler?: (params: {
    pluginId: string
    method: string
    input: WorkspaceRowBadgeInput
  }) => unknown | Promise<unknown>
): MockHostTransport {
  let catalog = initialCatalog
  let badgeHandler =
    initialHandler ??
    (() => [] as { folderId: number; label: string; tone?: string }[])
  const eventListeners = new Map<string, Set<EventListener>>()
  const reconnectListeners = new Set<() => void>()

  const callMock = vi.fn(async (method: string, params?: unknown) => {
    if (method === "host_plugins_list") {
      return catalog
    }
    if (method === "host_plugins_call") {
      return await badgeHandler(
        params as {
          pluginId: string
          method: string
          input: WorkspaceRowBadgeInput
        }
      )
    }
    return null
  })

  const transport: Transport = {
    isDesktop: () => false,
    call: callMock as Transport["call"],
    subscribe: async <T,>(event: string, callback: (payload: T) => void) => {
      let listeners = eventListeners.get(event)
      if (!listeners) {
        listeners = new Set()
        eventListeners.set(event, listeners)
      }
      const wrapped = callback as EventListener
      listeners.add(wrapped)
      return () => {
        listeners?.delete(wrapped)
      }
    },
    onReconnect: (callback: () => void) => {
      reconnectListeners.add(callback)
      return () => {
        reconnectListeners.delete(callback)
      }
    },
  }

  return {
    transport,
    callMock,
    emit: (event: string, payload?: unknown) => {
      for (const listener of eventListeners.get(event) ?? []) {
        listener(payload)
      }
    },
    triggerReconnect: () => {
      for (const listener of reconnectListeners) {
        listener()
      }
    },
    setCatalog: (plugins: InstalledPlugin[]) => {
      catalog = plugins
    },
    setBadgeHandler: (handler) => {
      badgeHandler = handler
    },
  }
}

const transportCtl = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  return {
    currentTransport: null as Transport | null,
    activeRemoteId: null as number | null,
    notify() {
      for (const listener of listeners) {
        listener()
      }
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    reset() {
      this.currentTransport = null
      this.activeRemoteId = null
      listeners.clear()
    },
  }
})

vi.mock("@/lib/transport", () => ({
  isDesktop: () => false,
  getTransport: () => {
    if (!transportCtl.currentTransport) {
      throw new Error("No mock transport configured")
    }
    return transportCtl.currentTransport
  },
  getActiveRemoteConnectionId: () => transportCtl.activeRemoteId,
  subscribeTransportChange: (listener: () => void) =>
    transportCtl.subscribe(listener),
}))

vi.mock("virtua", () => ({
  Virtualizer: ({
    data,
    children,
  }: {
    data: unknown[]
    children: (row: unknown, index: number) => ReactNode
  }) => <>{data.map((row, index) => children(row, index))}</>,
}))

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({
    children,
    onViewportRef,
  }: {
    children?: ReactNode
    onViewportRef?: (el: HTMLElement | null) => void
  }) => {
    useEffect(() => {
      onViewportRef?.(document.createElement("div"))
    }, [onViewportRef])
    return <>{children}</>
  },
}))

vi.mock("@/components/agent-icon", () => ({
  AgentIcon: () => null,
}))

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}))

vi.mock("@/hooks/use-appearance", () => ({
  useThemeColor: () => ({ themeColor: "blue" }),
  useZoomLevel: () => ({ zoomLevel: 100, setZoomLevel: () => {} }),
}))

vi.mock("@/hooks/use-sorted-available-agents", () => ({
  useSortedAvailableAgents: () => ({
    sortedTypes: ["claude_code"],
    fresh: true,
    refresh: () => {},
  }),
}))

vi.mock("@/contexts/terminal-context", () => ({
  useTerminalContext: () => ({ createTerminalInDirectory: () => {} }),
}))

vi.mock("@/contexts/task-context", () => ({
  useTaskContext: () => ({ addTask: () => {}, updateTask: () => {} }),
}))

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: null }),
}))

vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({
    openTab: () => {},
    closeConversationTab: () => {},
    closeTabsByFolder: () => {},
    openNewConversationTab: () => {},
    openChatModeTab: () => {},
  }),
  useTabStore: (
    selector: (s: { activeTabId: string | null; tabs: unknown[] }) => unknown
  ) => selector({ activeTabId: null, tabs: [] }),
}))

vi.mock("@/contexts/workbench-route-context", () => {
  const value = {
    routeId: "conversations",
    isConversations: true,
    setRoute: () => {},
    openConversations: () => {},
  }
  return { useWorkbenchRoute: () => value }
})

vi.mock("./conversation-manage-dialog", () => ({
  ConversationManageDialog: () => null,
}))

vi.mock("@/components/layout/clone-dialog", () => ({
  CloneDialog: () => null,
}))

vi.mock("@/components/layout/workspace-folder-dialog", () => ({
  WorkspaceFolderDialog: () => null,
}))

vi.mock("@/hooks/use-subsession-sync", () => ({
  useSubsessionSync: () => {},
}))

vi.mock("@/components/shared/directory-browser-dialog", () => ({
  DirectoryBrowserDialog: () => null,
}))

function makeFolder(
  id: number,
  name: string,
  overrides: Partial<FolderDetail> = {}
): FolderDetail {
  return {
    id,
    name,
    alias: null,
    path: `/repos/${name}`,
    color: "blue",
    default_agent_type: null,
    git_branch: null,
    parent_id: null,
    kind: "local",
    is_open: true,
    sort_order: id,
    group_id: null,
    ...overrides,
  } as unknown as FolderDetail
}

function makeBadgePlugin(
  overrides?: Partial<InstalledPlugin> & {
    id?: string
    methods?: string[]
    badges?: InstalledPlugin["manifest"]["contributes"]["workspaceRowBadges"]
  }
): InstalledPlugin {
  const id = overrides?.id ?? "codeg.workspace-row-badges"
  return {
    enabled: overrides?.enabled ?? true,
    manifest: {
      id,
      name: "Workspace Row Badges",
      version: "1.0.0",
      server: {
        entry: "badges.mjs",
        methods: overrides?.methods ?? ["worktree-badges"],
      },
      contributes: {
        workspacePanels: [],
        commands: [],
        hooks: [],
        workspaceRowBadges: overrides?.badges ?? [
          {
            id: "worktree",
            title: "Git worktree",
            titleTranslations: {
              es: "Árbol de trabajo de Git",
            },
            method: "worktree-badges",
          },
        ],
      },
    },
  }
}

function seedWorkspaces(
  folders: FolderDetail[],
  branches: Map<number, string | null> = new Map()
) {
  useAppWorkspaceStore.setState({
    folders,
    allFolders: folders,
    folderGroups: [],
    foldersHydrated: true,
    foldersLoading: false,
    conversations: [],
    conversationsLoading: false,
    conversationsError: null,
    branches,
    ensureGitHead: () => {},
  })
}

function renderList(opts?: { locale?: "en" | "es"; showWorktrees?: boolean }) {
  const locale = opts?.locale ?? "en"
  const messages = locale === "es" ? esMessages : enMessages
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <SidebarConversationList
        showCompleted
        showWorktrees={opts?.showWorktrees ?? true}
      />
    </NextIntlClientProvider>
  )
}

function badgeCalls(mock: MockHostTransport) {
  return mock.callMock.mock.calls.filter(
    ([method]) => method === "host_plugins_call"
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("SidebarConversationList workspace row badges", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/")
    localStorage.clear()
    resetAppWorkspaceStore()
    resetFolderTabsStore()
    transportCtl.reset()
  })

  afterEach(() => {
    window.history.replaceState({}, "", "/")
    transportCtl.reset()
  })

  it("renders badges beside real root and worktree titles, skips synthetic root sub-groups and chat folders, and shares one batched RPC per plugin+method", async () => {
    const rootRepo = makeFolder(1, "codeg", { git_branch: "old-main" })
    const worktree = makeFolder(2, "codeg-wt", {
      parent_id: 1,
      git_branch: "feat/badges",
    })
    const plainRoot = makeFolder(3, "docs")
    const chatFolder = makeFolder(99, "__chat__", { kind: "chat" })

    seedWorkspaces(
      [rootRepo, worktree, plainRoot, chatFolder],
      new Map([[1, "main"]])
    )

    const plugin = makeBadgePlugin({
      methods: ["shared-badges"],
      badges: [
        {
          id: "primary",
          title: "Workspace status",
          titleTranslations: { es: "Estado del espacio" },
          method: "shared-badges",
        },
        {
          id: "secondary",
          title: "Git worktree",
          titleTranslations: { es: "Árbol de trabajo de Git" },
          method: "shared-badges",
        },
      ],
    })

    const host = createMockHostTransport([plugin], ({ input }) => {
      return input.workspaces.flatMap((ws) => {
        if (ws.folderId === 1) {
          return [{ folderId: 1, label: "Root OK", tone: "success" }]
        }
        if (ws.parentFolderId !== null) {
          return [{ folderId: ws.folderId, label: "Git", tone: "info" }]
        }
        return []
      })
    })
    transportCtl.currentTransport = host.transport

    const { container } = renderList({ locale: "es", showWorktrees: true })

    // Wait for both real root and worktree badges to appear
    await waitFor(() => {
      expect(
        container.querySelectorAll('[data-slot="plugin-workspace-row-badge"]')
          .length
      ).toBe(4)
    })

    // Exactly ONE batched RPC for the shared (pluginId, method) across all 3 real workspaces
    const calls = badgeCalls(host)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[1]).toEqual({
      pluginId: "codeg.workspace-row-badges",
      method: "shared-badges",
      input: {
        locale: "es",
        workspaces: [
          { folderId: 1, parentFolderId: null, branch: "main" },
          { folderId: 2, parentFolderId: 1, branch: "feat/badges" },
          { folderId: 3, parentFolderId: null, branch: null },
        ],
      },
    })

    // Container repo (folder 1) renders TWO rows with data-folder-id="1":
    // 1) the real repo header ("codeg") — MUST show badges
    // 2) the synthetic "root" sub-group ("main [ root ]") — MUST NOT duplicate badges
    const folder1Buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        'button[data-folder-id="1"]'
      )
    )
    expect(folder1Buttons).toHaveLength(2)
    const realRootButton = folder1Buttons[0]!
    const syntheticRootSubgroupButton = folder1Buttons[1]!

    const rootBadges = realRootButton.querySelectorAll(
      '[data-slot="plugin-workspace-row-badge"]'
    )
    expect(rootBadges).toHaveLength(2)
    expect(
      within(realRootButton).getByTitle("Estado del espacio: Root OK")
    ).toHaveAttribute("data-badge-tone", "success")
    expect(
      syntheticRootSubgroupButton.querySelectorAll(
        '[data-slot="plugin-workspace-row-badge"]'
      )
    ).toHaveLength(0)

    // Worktree row (folder 2) shows localized title + badge tone and preserves primary trailing controls
    const worktreeButton = container.querySelector<HTMLButtonElement>(
      'button[data-folder-id="2"]'
    )!
    expect(worktreeButton).toBeTruthy()
    expect(
      within(worktreeButton).getByTitle("Árbol de trabajo de Git: Git")
    ).toHaveAttribute("data-badge-tone", "info")
    expect(
      worktreeButton.parentElement?.querySelectorAll("button").length
    ).toBeGreaterThanOrEqual(3)

    // Plain root without a badge entry shows none
    const plainButton = container.querySelector<HTMLButtonElement>(
      'button[data-folder-id="3"]'
    )!
    expect(
      plainButton.querySelectorAll('[data-slot="plugin-workspace-row-badge"]')
    ).toHaveLength(0)
  })

  it("chunks large workspace lists into bounded batches and rejects cross-batch, unrequested, and duplicate folderIds", async () => {
    const total = WORKSPACE_ROW_BADGE_BATCH_SIZE + 5
    const folders = Array.from({ length: total }, (_, index) =>
      makeFolder(index + 1, `repo-${index + 1}`)
    )
    seedWorkspaces(folders)

    const plugin = makeBadgePlugin({
      badges: [{ id: "status", title: "Status", method: "worktree-badges" }],
    })
    const host = createMockHostTransport([plugin], ({ input }) => {
      const firstId = input.workspaces[0]?.folderId
      if (firstId === 1) {
        return [
          { folderId: 1, label: "Batch1 First", tone: "info" },
          { folderId: 1, label: "Batch1 Duplicate", tone: "danger" },
          // Attempt to inject a badge for folder 69 (which is in batch 2!) and nonexistent 9999
          { folderId: total, label: "CrossBatch Spoof", tone: "danger" },
          { folderId: 9999, label: "Unknown", tone: "danger" },
        ]
      }
      return [{ folderId: total, label: "Batch2 Real", tone: "success" }]
    })
    transportCtl.currentTransport = host.transport

    const { container } = renderList({ showWorktrees: false })

    await waitFor(() => {
      const lastButton = container.querySelector<HTMLButtonElement>(
        `button[data-folder-id="${total}"]`
      )
      expect(lastButton?.textContent).toContain("Batch2 Real")
    })

    const calls = badgeCalls(host)
    expect(calls).toHaveLength(2)
    expect(
      (calls[0]?.[1] as { input: WorkspaceRowBadgeInput }).input.workspaces
    ).toHaveLength(WORKSPACE_ROW_BADGE_BATCH_SIZE)
    expect(
      (calls[1]?.[1] as { input: WorkspaceRowBadgeInput }).input.workspaces
    ).toHaveLength(5)

    const firstButton = container.querySelector<HTMLButtonElement>(
      'button[data-folder-id="1"]'
    )!
    expect(within(firstButton).getByText("Batch1 First")).toBeTruthy()
    expect(within(firstButton).queryByText("Batch1 Duplicate")).toBeNull()

    const lastButton = container.querySelector<HTMLButtonElement>(
      `button[data-folder-id="${total}"]`
    )!
    expect(within(lastButton).getByText("Batch2 Real")).toBeTruthy()
    expect(within(lastButton).queryByText("CrossBatch Spoof")).toBeNull()
  })

  it("isolates throwing or malformed RPC responses while keeping valid sibling plugin badges", async () => {
    seedWorkspaces([makeFolder(1, "alpha"), makeFolder(2, "beta")])

    const failingPlugin = makeBadgePlugin({
      id: "acme.throws",
      methods: ["boom"],
      badges: [{ id: "boom", title: "Boom", method: "boom" }],
    })
    const nonArrayPlugin = makeBadgePlugin({
      id: "acme.non-array",
      methods: ["wrong-shape"],
      badges: [{ id: "wrong", title: "Wrong", method: "wrong-shape" }],
    })
    const mixedPlugin = makeBadgePlugin({
      id: "acme.mixed",
      methods: ["mixed"],
      badges: [{ id: "mixed", title: "Mixed", method: "mixed" }],
    })

    const host = createMockHostTransport(
      [failingPlugin, nonArrayPlugin, mixedPlugin],
      ({ pluginId }) => {
        if (pluginId === "acme.throws") {
          throw new Error("worker crashed")
        }
        if (pluginId === "acme.non-array") {
          return { folderId: 1, label: "NotAnArray" }
        }
        return [
          { folderId: 1, label: "   ", tone: "info" },
          { folderId: 1, label: "bad\nline", tone: "info" },
          { folderId: 1, label: "🚀".repeat(33), tone: "info" },
          { folderId: 1, label: "BadTone", tone: "neon" },
          { folderId: 1, label: "Healthy", tone: "warning" },
          { folderId: 2, label: " leading", tone: "success" },
          { folderId: 777, label: "Foreign", tone: "danger" },
        ]
      }
    )
    transportCtl.currentTransport = host.transport

    const { container } = renderList({ showWorktrees: false })

    await waitFor(() => {
      const alphaButton = container.querySelector<HTMLButtonElement>(
        'button[data-folder-id="1"]'
      )!
      expect(within(alphaButton).getByText("Healthy")).toBeTruthy()
    })

    const badges = container.querySelectorAll(
      '[data-slot="plugin-workspace-row-badge"]'
    )
    expect(badges).toHaveLength(1)
    expect(badges[0]).toHaveAttribute("data-badge-tone", "warning")
    expect(badges[0]).toHaveAttribute("title", "Mixed: Healthy")
  })

  it("withdraws badges immediately on plugin disable and rejects late in-flight responses", async () => {
    seedWorkspaces([
      makeFolder(1, "repo"),
      makeFolder(2, "repo-wt", { parent_id: 1, git_branch: "feat/1" }),
    ])

    const enabledPlugin = makeBadgePlugin()
    const disabledPlugin: InstalledPlugin = {
      ...enabledPlugin,
      enabled: false,
    }

    const pendingAfterBranchChange =
      deferred<{ folderId: number; label: string; tone?: string }[]>()
    let callCount = 0

    const host = createMockHostTransport([enabledPlugin], () => {
      callCount += 1
      if (callCount === 1) {
        return [{ folderId: 2, label: "Git", tone: "info" }]
      }
      return pendingAfterBranchChange.promise
    })
    transportCtl.currentTransport = host.transport

    const { container } = renderList({ showWorktrees: true })

    await waitFor(() => {
      expect(
        container.querySelector('[data-slot="plugin-workspace-row-badge"]')
          ?.textContent
      ).toContain("Git")
    })

    // Start a second in-flight RPC via a workspace branch update
    act(() => {
      useAppWorkspaceStore.getState().setBranch(2, "feat/2")
    })
    await waitFor(() => {
      expect(badgeCalls(host)).toHaveLength(2)
    })

    // Disable plugin while second RPC is still in flight
    host.setCatalog([disabledPlugin])
    act(() => {
      host.emit("host-plugins://changed")
    })

    await waitFor(() => {
      expect(
        container.querySelectorAll('[data-slot="plugin-workspace-row-badge"]')
      ).toHaveLength(0)
    })

    // Resolve the stale in-flight RPC — MUST be rejected and never render
    await act(async () => {
      pendingAfterBranchChange.resolve([
        { folderId: 2, label: "StaleAfterDisable", tone: "danger" },
      ])
      await Promise.resolve()
    })

    expect(
      container.querySelectorAll('[data-slot="plugin-workspace-row-badge"]')
    ).toHaveLength(0)
    expect(container.textContent).not.toContain("StaleAfterDisable")

    // Re-enabling must NOT flash pre-disable badges before the fresh RPC settles,
    // and removing (uninstalling) the plugin must withdraw the fresh badge immediately.
    const pendingAfterReenable =
      deferred<{ folderId: number; label: string; tone?: string }[]>()
    host.setBadgeHandler(() => pendingAfterReenable.promise)
    host.setCatalog([enabledPlugin])
    act(() => {
      host.emit("host-plugins://changed")
    })
    await waitFor(() => {
      expect(badgeCalls(host)).toHaveLength(3)
    })
    expect(
      container.querySelectorAll('[data-slot="plugin-workspace-row-badge"]')
    ).toHaveLength(0)

    await act(async () => {
      pendingAfterReenable.resolve([
        { folderId: 2, label: "FreshGit", tone: "success" },
      ])
    })
    await waitFor(() => {
      expect(container.textContent).toContain("FreshGit")
    })

    // Removing the plugin immediately withdraws the badge
    host.setCatalog([])
    act(() => {
      host.emit("host-plugins://changed")
    })
    await waitFor(() => {
      expect(
        container.querySelectorAll('[data-slot="plugin-workspace-row-badge"]')
      ).toHaveLength(0)
    })
  })

  it("refreshes badges when workspaces change and when the same host transport emits catalog change or reconnects", async () => {
    seedWorkspaces([makeFolder(1, "repo", { git_branch: "main" })])

    let phase = "initial"
    const host = createMockHostTransport([makeBadgePlugin()], ({ input }) => {
      const branch = input.workspaces[0]?.branch ?? "none"
      return input.workspaces.map((ws) => ({
        folderId: ws.folderId,
        label: `${phase}:${ws.folderId}:${branch}`,
        tone: "muted",
      }))
    })
    transportCtl.currentTransport = host.transport

    const { container } = renderList({ showWorktrees: false })

    await waitFor(() => {
      expect(container.textContent).toContain("initial:1:main")
    })
    expect(badgeCalls(host)).toHaveLength(1)

    // Workspace branch change triggers refresh
    phase = "branch"
    act(() => {
      useAppWorkspaceStore.getState().setBranch(1, "feat/refresh")
    })
    await waitFor(() => {
      expect(container.textContent).toContain("branch:1:feat/refresh")
    })
    expect(badgeCalls(host)).toHaveLength(2)

    // Same transport reconnect triggers refresh
    phase = "reconnect"
    act(() => {
      host.triggerReconnect()
    })
    await waitFor(() => {
      expect(container.textContent).toContain("reconnect:1:feat/refresh")
    })
    expect(badgeCalls(host)).toHaveLength(3)

    // Same transport host-plugins://changed triggers refresh
    phase = "changed"
    act(() => {
      host.emit("host-plugins://changed")
    })
    await waitFor(() => {
      expect(container.textContent).toContain("changed:1:feat/refresh")
    })
    expect(badgeCalls(host)).toHaveLength(4)
  })

  it("gates remote window boot until transport matches remoteConnectionId and immediately withdraws + refreshes when transport is replaced under the same remoteConnectionId", async () => {
    seedWorkspaces([
      makeFolder(1, "remote-repo"),
      makeFolder(2, "remote-wt", { parent_id: 1, git_branch: "feat/remote" }),
    ])

    // Remote window booting: URL specifies remoteConnectionId=7, but active transport is still local (null)
    window.history.replaceState({}, "", "/?remoteConnectionId=7")
    const localHost = createMockHostTransport([makeBadgePlugin()], () => [
      { folderId: 2, label: "LocalLeak", tone: "danger" },
    ])
    transportCtl.currentTransport = localHost.transport
    transportCtl.activeRemoteId = null

    const { container } = renderList({ showWorktrees: true })

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    // Local transport MUST NOT be queried while remote window is booting
    expect(localHost.callMock).not.toHaveBeenCalled()
    expect(
      container.querySelectorAll('[data-slot="plugin-workspace-row-badge"]')
    ).toHaveLength(0)

    // Remote transport A connects for remoteConnectionId=7
    const staleRemoteAPending =
      deferred<{ folderId: number; label: string; tone?: string }[]>()
    let remoteACalls = 0
    const remoteHostA = createMockHostTransport([makeBadgePlugin()], () => {
      remoteACalls += 1
      if (remoteACalls === 1) {
        return [{ folderId: 2, label: "Remote A", tone: "info" }]
      }
      return staleRemoteAPending.promise
    })
    transportCtl.currentTransport = remoteHostA.transport
    transportCtl.activeRemoteId = 7
    act(() => {
      transportCtl.notify()
    })

    await waitFor(() => {
      expect(container.textContent).toContain("Remote A")
    })

    // Start an in-flight RPC on remoteHostA before replacing the transport
    act(() => {
      useAppWorkspaceStore.getState().setBranch(2, "feat/remote-2")
    })
    await waitFor(() => {
      expect(badgeCalls(remoteHostA)).toHaveLength(2)
    })

    // Replace transport object under the SAME remoteConnectionId=7 (e.g. reconnect/reconfig)
    const remoteBCatalogGate = deferred<InstalledPlugin[]>()
    const remoteHostB = createMockHostTransport([], () => [
      { folderId: 2, label: "Remote B", tone: "success" },
    ])
    const originalBCall = remoteHostB.transport.call
    remoteHostB.transport.call = vi.fn(
      async (method: string, params?: Record<string, unknown>) => {
        if (method === "host_plugins_list") {
          return await remoteBCatalogGate.promise
        }
        return await originalBCall(method, params)
      }
    ) as Transport["call"]

    transportCtl.currentTransport = remoteHostB.transport
    // Same remoteConnectionId (7), new Transport object identity!
    transportCtl.activeRemoteId = 7
    act(() => {
      transportCtl.notify()
    })

    // Badges from remoteHostA MUST be withdrawn immediately before remoteHostB finishes loading
    expect(
      container.querySelectorAll('[data-slot="plugin-workspace-row-badge"]')
    ).toHaveLength(0)
    expect(container.textContent).not.toContain("Remote A")

    // Resolve stale RPC from remoteHostA — MUST be rejected
    await act(async () => {
      staleRemoteAPending.resolve([
        { folderId: 2, label: "Stale From A", tone: "danger" },
      ])
      await Promise.resolve()
    })
    expect(container.textContent).not.toContain("Stale From A")

    // Finish loading remoteHostB catalog and badges
    await act(async () => {
      remoteBCatalogGate.resolve([makeBadgePlugin()])
    })
    await waitFor(() => {
      expect(container.textContent).toContain("Remote B")
    })
    expect(container.textContent).not.toContain("Remote A")
    expect(container.textContent).not.toContain("LocalLeak")
  })

  it("bounds method-group concurrency below the 4-slot host limit so 6+ badge methods never hit busy and isolates failing groups", async () => {
    seedWorkspaces([makeFolder(1, "alpha", { git_branch: "main" })])

    const plugins: InstalledPlugin[] = Array.from({ length: 6 }, (_, index) =>
      makeBadgePlugin({
        id: `acme.badge-${index + 1}`,
        methods: [`method-${index + 1}`],
        badges: [
          {
            id: `b-${index + 1}`,
            title: `Badge ${index + 1}`,
            method: `method-${index + 1}`,
          },
        ],
      })
    )

    const HOST_RUNTIME_SLOTS = 4
    let inFlight = 0
    let maxConcurrent = 0
    let busyErrors = 0
    const pendingGates = new Map<
      string,
      ReturnType<
        typeof deferred<{ folderId: number; label: string; tone?: string }[]>
      >
    >()

    const host = createMockHostTransport(plugins, async ({ pluginId }) => {
      inFlight += 1
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      if (inFlight > HOST_RUNTIME_SLOTS) {
        inFlight -= 1
        busyErrors += 1
        throw new Error("Plugin runtime is busy")
      }
      const gate =
        deferred<{ folderId: number; label: string; tone?: string }[]>()
      pendingGates.set(pluginId, gate)
      try {
        return await gate.promise
      } finally {
        inFlight -= 1
      }
    })
    transportCtl.currentTransport = host.transport

    const { container } = renderList({ showWorktrees: false })

    // Fixed worker pool starts at most WORKSPACE_ROW_BADGE_MAX_CONCURRENCY (2) groups at once
    await waitFor(() => {
      expect(pendingGates.size).toBe(WORKSPACE_ROW_BADGE_MAX_CONCURRENCY)
    })
    expect(badgeCalls(host)).toHaveLength(WORKSPACE_ROW_BADGE_MAX_CONCURRENCY)
    expect(maxConcurrent).toBe(WORKSPACE_ROW_BADGE_MAX_CONCURRENCY)

    // Drain all 6 groups step by step, verifying concurrency never exceeds 2
    for (let index = 1; index <= 6; index += 1) {
      const pluginId = `acme.badge-${index}`
      await waitFor(() => {
        expect(pendingGates.has(pluginId)).toBe(true)
      })
      await act(async () => {
        pendingGates
          .get(pluginId)!
          .resolve([{ folderId: 1, label: `B${index}`, tone: "info" }])
        await Promise.resolve()
      })
    }

    await waitFor(() => {
      expect(
        container.querySelectorAll('[data-slot="plugin-workspace-row-badge"]')
      ).toHaveLength(6)
    })

    expect(busyErrors).toBe(0)
    expect(maxConcurrent).toBe(WORKSPACE_ROW_BADGE_MAX_CONCURRENCY)
    expect(maxConcurrent).toBeLessThanOrEqual(HOST_RUNTIME_SLOTS)
    for (let index = 1; index <= 6; index += 1) {
      expect(container.textContent).toContain(`B${index}`)
    }
  })

  it("does not launch queued method groups after cancellation and isolates failing methods from queued peers", async () => {
    seedWorkspaces([makeFolder(1, "alpha", { git_branch: "main" })])

    const plugins: InstalledPlugin[] = Array.from({ length: 6 }, (_, index) =>
      makeBadgePlugin({
        id: `acme.queue-${index + 1}`,
        methods: [`m-${index + 1}`],
        badges: [
          {
            id: `q-${index + 1}`,
            title: `Queue ${index + 1}`,
            method: `m-${index + 1}`,
          },
        ],
      })
    )

    const startedPlugins: string[] = []
    const gates = new Map<
      string,
      ReturnType<
        typeof deferred<{ folderId: number; label: string; tone?: string }[]>
      >
    >()

    const host = createMockHostTransport(plugins, async ({ pluginId }) => {
      startedPlugins.push(pluginId)
      if (pluginId === "acme.queue-1") {
        throw new Error("plugin 1 crashed")
      }
      const gate =
        deferred<{ folderId: number; label: string; tone?: string }[]>()
      gates.set(pluginId, gate)
      return await gate.promise
    })
    transportCtl.currentTransport = host.transport

    const { container } = renderList({ showWorktrees: false })

    // Group 1 throws immediately; worker 1 isolates the error and picks up group 3
    // while worker 2 holds group 2. Groups 4..6 remain queued.
    await waitFor(() => {
      expect(gates.has("acme.queue-2")).toBe(true)
      expect(gates.has("acme.queue-3")).toBe(true)
    })
    expect(startedPlugins).toEqual([
      "acme.queue-1",
      "acme.queue-2",
      "acme.queue-3",
    ])

    // Cancel by removing all plugins and flushing the catalog update before groups 4..6 start
    host.setCatalog([])
    await act(async () => {
      host.emit("host-plugins://changed")
      await Promise.resolve()
      await Promise.resolve()
    })

    await act(async () => {
      gates
        .get("acme.queue-2")!
        .resolve([{ folderId: 1, label: "Stale2", tone: "danger" }])
      gates
        .get("acme.queue-3")!
        .resolve([{ folderId: 1, label: "Stale3", tone: "danger" }])
      await Promise.resolve()
      await Promise.resolve()
    })

    // Queued groups 4..6 MUST NOT have been invoked after cancellation
    expect(startedPlugins).toEqual([
      "acme.queue-1",
      "acme.queue-2",
      "acme.queue-3",
    ])
    expect(
      container.querySelectorAll('[data-slot="plugin-workspace-row-badge"]')
    ).toHaveLength(0)
    expect(container.textContent).not.toContain("Stale2")
    expect(container.textContent).not.toContain("Stale3")
  })

  it("respects the 64 KiB UTF-8 JSON input limit across long multi-byte branches without mutating normal branch names", async () => {
    const encoder = new TextEncoder()
    const longPrefix = `feat/多字节分支-${"汉".repeat(400)}-🌿`
    const folders = Array.from({ length: 64 }, (_, index) =>
      makeFolder(index + 1, `repo-${index + 1}`, {
        git_branch: `${longPrefix}-${index + 1}`,
      })
    )
    seedWorkspaces(folders)

    const plugin = makeBadgePlugin({
      badges: [{ id: "branch", title: "Branch", method: "worktree-badges" }],
    })
    const seenBranches = new Map<number, string | null>()
    const batchByteSizes: number[] = []

    const host = createMockHostTransport([plugin], ({ input }) => {
      const payloadBytes = encoder.encode(JSON.stringify(input)).byteLength
      batchByteSizes.push(payloadBytes)
      if (payloadBytes > MAX_WORKSPACE_ROW_BADGE_INPUT_BYTES) {
        throw new Error("Plugin input exceeds 64 KiB")
      }
      for (const ws of input.workspaces) {
        seenBranches.set(ws.folderId, ws.branch)
      }
      return input.workspaces
        .filter((ws) => ws.folderId === 1 || ws.folderId === 64)
        .map((ws) => ({
          folderId: ws.folderId,
          label: `Fit-${ws.folderId}`,
          tone: "success",
        }))
    })
    transportCtl.currentTransport = host.transport

    const { container } = renderList({ showWorktrees: false })

    await waitFor(() => {
      expect(container.textContent).toContain("Fit-1")
      expect(container.textContent).toContain("Fit-64")
    })

    expect(batchByteSizes.length).toBeGreaterThan(1)
    for (const bytes of batchByteSizes) {
      expect(bytes).toBeLessThanOrEqual(MAX_WORKSPACE_ROW_BADGE_INPUT_BYTES)
    }
    expect(seenBranches.size).toBe(64)
    expect(seenBranches.get(1)).toBe(`${longPrefix}-1`)
    expect(seenBranches.get(64)).toBe(`${longPrefix}-64`)
  })

  it("enforces the concurrency cap across consecutive refresh epochs on the same transport without blocking a different transport", async () => {
    seedWorkspaces([makeFolder(1, "alpha", { git_branch: "v1" })])

    const plugins: InstalledPlugin[] = Array.from({ length: 3 }, (_, index) =>
      makeBadgePlugin({
        id: `acme.epoch-${index + 1}`,
        methods: [`m-${index + 1}`],
        badges: [
          {
            id: `e-${index + 1}`,
            title: `Epoch ${index + 1}`,
            method: `m-${index + 1}`,
          },
        ],
      })
    )

    const HOST_RUNTIME_SLOTS = 4
    let inFlightA = 0
    let maxConcurrentA = 0
    let busyErrorsA = 0
    const callLogA: Array<{
      pluginId: string
      branch: string | null
      gate: ReturnType<
        typeof deferred<{ folderId: number; label: string; tone?: string }[]>
      >
    }> = []

    const hostA = createMockHostTransport(
      plugins,
      async ({ pluginId, input }) => {
        inFlightA += 1
        maxConcurrentA = Math.max(maxConcurrentA, inFlightA)
        if (inFlightA > HOST_RUNTIME_SLOTS) {
          inFlightA -= 1
          busyErrorsA += 1
          throw new Error("Plugin runtime is busy")
        }
        const gate =
          deferred<{ folderId: number; label: string; tone?: string }[]>()
        callLogA.push({
          pluginId,
          branch: input.workspaces[0]?.branch ?? null,
          gate,
        })
        try {
          return await gate.promise
        } finally {
          inFlightA -= 1
        }
      }
    )
    transportCtl.currentTransport = hostA.transport

    const { container } = renderList({ showWorktrees: false })

    // Epoch 1 starts 2 in-flight RPCs; group 3 stays queued.
    await waitFor(() => {
      expect(callLogA).toHaveLength(2)
    })
    expect(inFlightA).toBe(2)

    // Consecutive refreshes (host-plugins://changed + branch updates) while
    // epoch 1's 2 RPCs are STILL in flight must NOT stack new RPCs on top.
    await act(async () => {
      hostA.emit("host-plugins://changed")
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() => {
      useAppWorkspaceStore.getState().setBranch(1, "v2")
    })
    await act(async () => {
      hostA.emit("host-plugins://changed")
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() => {
      useAppWorkspaceStore.getState().setBranch(1, "v3")
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // Still only the original 2 in-flight calls on hostA — no cross-epoch overflow!
    expect(callLogA).toHaveLength(2)
    expect(inFlightA).toBe(2)
    expect(maxConcurrentA).toBe(WORKSPACE_ROW_BADGE_MAX_CONCURRENCY)
    expect(busyErrorsA).toBe(0)

    // Settling epoch 1's stale calls releases the 2 slots to the latest epoch (v3),
    // skipping all cancelled queued groups from epochs 1 and 2.
    await act(async () => {
      callLogA[0]!.gate.resolve([
        { folderId: 1, label: "StaleV1-A", tone: "danger" },
      ])
      callLogA[1]!.gate.resolve([
        { folderId: 1, label: "StaleV1-B", tone: "danger" },
      ])
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(callLogA).toHaveLength(4)
    })
    expect(callLogA[2]!.branch).toBe("v3")
    expect(callLogA[3]!.branch).toBe("v3")
    expect(maxConcurrentA).toBe(WORKSPACE_ROW_BADGE_MAX_CONCURRENCY)
    expect(container.textContent).not.toContain("StaleV1")

    // Drain epoch 3's first 2 calls -> triggers epoch 3's 3rd call -> all 3 render
    await act(async () => {
      callLogA[2]!.gate.resolve([{ folderId: 1, label: "V3-1", tone: "info" }])
      callLogA[3]!.gate.resolve([{ folderId: 1, label: "V3-2", tone: "info" }])
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(callLogA).toHaveLength(5)
    })
    expect(callLogA[4]!.branch).toBe("v3")
    await act(async () => {
      callLogA[4]!.gate.resolve([{ folderId: 1, label: "V3-3", tone: "info" }])
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(
        container.querySelectorAll('[data-slot="plugin-workspace-row-badge"]')
      ).toHaveLength(3)
    })
    expect(container.textContent).toContain("V3-1")
    expect(container.textContent).toContain("V3-2")
    expect(container.textContent).toContain("V3-3")
    expect(maxConcurrentA).toBe(WORKSPACE_ROW_BADGE_MAX_CONCURRENCY)
    expect(busyErrorsA).toBe(0)

    // Now start 2 hung RPCs on hostA, then switch to a DIFFERENT Transport (hostB):
    // hostB MUST start immediately without waiting for hostA's hung RPCs to settle.
    act(() => {
      useAppWorkspaceStore.getState().setBranch(1, "v4-hung-on-A")
    })
    await waitFor(() => {
      expect(callLogA).toHaveLength(7)
    })
    expect(inFlightA).toBe(2)

    const hostB = createMockHostTransport([plugins[0]!], () => [
      { folderId: 1, label: "FreshOnHostB", tone: "success" },
    ])
    transportCtl.currentTransport = hostB.transport
    act(() => {
      transportCtl.notify()
    })

    // hostB resolves immediately even while hostA still has 2 unsettled in-flight RPCs
    await waitFor(() => {
      expect(container.textContent).toContain("FreshOnHostB")
    })
    expect(inFlightA).toBe(2)
  })
})
