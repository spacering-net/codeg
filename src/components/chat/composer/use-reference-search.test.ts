import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { FlatFileEntry } from "@/hooks/use-file-tree"
import type {
  AcpAgentInfo,
  AssistantInfo,
  DbConversationSummary,
  GitLogEntry,
} from "@/lib/types"
import {
  resetAssistantsStore,
  useAssistantsStore,
} from "@/stores/assistants-store"

import type { ReferenceKind } from "./types"
import type { SuggestionGroup } from "./suggestion/types"
import {
  buildReferenceGroups,
  DEFAULT_GROUP_LABELS,
  useReferenceSearch,
  type ReferenceSearchSources,
} from "./use-reference-search"

// --- fixtures ---------------------------------------------------------------

function makeFile(
  relativePath: string,
  kind: "file" | "dir" = "file"
): FlatFileEntry {
  const name = relativePath.split("/").pop() ?? relativePath
  return {
    name,
    relativePath,
    kind,
    lowerPath: relativePath.toLowerCase(),
    lowerName: name.toLowerCase(),
  }
}

function makeAgent(
  agentType: string,
  over: { name?: string; description?: string; enabled?: boolean } = {}
): AcpAgentInfo {
  return {
    agent_type: agentType,
    name: over.name ?? agentType,
    description: over.description ?? "",
    available: true,
    enabled: over.enabled ?? true,
    sort_order: 0,
  } as unknown as AcpAgentInfo
}

function makeAssistant(
  id: number,
  name: string,
  over: Partial<AssistantInfo> = {}
): AssistantInfo {
  return {
    id,
    uid: `u-${id}`,
    name,
    description: "",
    avatar: { kind: "monogram", color: "teal" },
    agent_type: "codex",
    agent_options: { config_values: {} },
    label_snapshot: { agent: "Codex", mode: null, options: [] },
    instructions: "",
    enabled: true,
    sort_order: id,
    revision: 1,
    created_at: "2026-10-16T00:00:00Z",
    updated_at: "2026-10-16T00:00:00Z",
    deleted_at: null,
    ...over,
  }
}

function makeConversation(id: number, title: string): DbConversationSummary {
  return {
    id,
    title,
    agent_type: "claude_code",
    status: "idle",
    git_branch: null,
  } as unknown as DbConversationSummary
}

function makeCommit(
  hash: string,
  message = "msg",
  author = "Dev"
): GitLogEntry {
  return {
    hash,
    full_hash: `${hash}0000`,
    author,
    date: "2026-01-01",
    message,
    files: [],
    pushed: false,
  }
}

function emptySources(
  over: Partial<ReferenceSearchSources> = {}
): ReferenceSearchSources {
  return {
    files: [],
    workspaceRoot: null,
    agents: [],
    assistants: [],
    sessions: [],
    commits: [],
    repoKey: null,
    ...over,
  }
}

const itemsOf = (groups: SuggestionGroup[], kind: ReferenceKind) =>
  groups.find((g) => g.kind === kind)?.items ?? []

// --- pure builder -----------------------------------------------------------

describe("buildReferenceGroups", () => {
  it("lists and searches each enabled custom account as a distinct mention target", () => {
    const agents = [2, 3, 4, 5].map((slot) =>
      makeAgent(`custom:claude-code-${slot}`, { name: `Claude Code ${slot}` })
    )
    const sources = emptySources({
      agents: [
        ...agents,
        makeAgent("custom:codex-2", { name: "Codex 2", enabled: false }),
      ],
    })
    const options = itemsOf(buildReferenceGroups("", sources), "agent")
    expect(options.map((item) => item.reference.id)).toEqual(
      agents.map((agent) => agent.agent_type)
    )
    expect(options.map((item) => item.reference.label)).toEqual(
      agents.map((agent) => agent.name)
    )
    expect(
      itemsOf(buildReferenceGroups("Claude Code 3", sources), "agent").map(
        (item) => item.reference.id
      )
    ).toEqual(["custom:claude-code-3"])
  })

  it("returns the five groups in a fixed order (no skill group)", () => {
    const groups = buildReferenceGroups("", emptySources())
    expect(groups.map((g) => g.kind)).toEqual([
      "file",
      "agent",
      "assistant",
      "session",
      "commit",
    ])
  })

  it("keeps every group present (empty groups are not dropped)", () => {
    const groups = buildReferenceGroups("", emptySources())
    expect(groups).toHaveLength(5)
    expect(groups.every((g) => g.items.length === 0)).toBe(true)
  })

  it("defaults the group headings to the English labels", () => {
    const groups = buildReferenceGroups("", emptySources())
    expect(groups.map((g) => g.label)).toEqual([
      DEFAULT_GROUP_LABELS.file,
      DEFAULT_GROUP_LABELS.agent,
      DEFAULT_GROUP_LABELS.assistant,
      DEFAULT_GROUP_LABELS.session,
      DEFAULT_GROUP_LABELS.commit,
    ])
  })

  it("accepts injected (localized) group headings", () => {
    const labels = {
      file: "文件",
      agent: "智能体",
      assistant: "助手",
      session: "会话",
      commit: "提交",
      skill: "技能",
    }
    const groups = buildReferenceGroups("", emptySources(), labels)
    expect(itemsOf(groups, "file")).toBeDefined()
    expect(groups.find((g) => g.kind === "agent")?.label).toBe("智能体")
  })

  it("adapts files into file:// references rooted at the workspace", () => {
    const groups = buildReferenceGroups(
      "",
      emptySources({
        files: [makeFile("a.ts"), makeFile("src/app.ts")],
        workspaceRoot: "/repo",
      })
    )
    const files = itemsOf(groups, "file")
    expect(files).toHaveLength(2)
    expect(files.map((f) => f.reference.uri)).toEqual([
      "file:///repo/a.ts",
      "file:///repo/src/app.ts",
    ])
  })

  it("filters files by name or relative path, case-insensitively", () => {
    const groups = buildReferenceGroups(
      "APP",
      emptySources({
        files: [makeFile("a.ts"), makeFile("src/App.tsx")],
        workspaceRoot: "/repo",
      })
    )
    const files = itemsOf(groups, "file")
    expect(files).toHaveLength(1)
    expect(files[0].reference.id).toBe("src/App.tsx")
  })

  it("omits the file group when there is no workspace root (R8)", () => {
    const groups = buildReferenceGroups(
      "",
      emptySources({ files: [makeFile("a.ts")], workspaceRoot: null })
    )
    expect(itemsOf(groups, "file")).toHaveLength(0)
  })

  it("filters agents by name / type / description", () => {
    const groups = buildReferenceGroups(
      "codex",
      emptySources({
        agents: [
          makeAgent("codex", { name: "Codex" }),
          makeAgent("gemini", { name: "Gemini" }),
        ],
      })
    )
    const agents = itemsOf(groups, "agent")
    expect(agents).toHaveLength(1)
    expect(agents[0].reference.id).toBe("codex")
  })

  it("excludes disabled agents (only enabled agents are mentionable)", () => {
    const groups = buildReferenceGroups(
      "",
      emptySources({
        agents: [
          makeAgent("codex", { name: "Codex" }),
          makeAgent("gemini", { name: "Gemini", enabled: false }),
        ],
      })
    )
    const agents = itemsOf(groups, "agent")
    expect(agents).toHaveLength(1)
    expect(agents[0].reference.id).toBe("codex")
  })

  it("adapts assistants into codeg://assistant references", () => {
    const groups = buildReferenceGroups(
      "",
      emptySources({
        agents: [makeAgent("codex", { name: "Codex" })],
        assistants: [
          makeAssistant(3, "Reviewer", { description: "Reviews diffs" }),
          makeAssistant(4, "Planner"),
        ],
      })
    )
    const items = itemsOf(groups, "assistant")
    expect(items.map((i) => i.reference)).toEqual([
      {
        refType: "assistant",
        id: "3",
        label: "Reviewer",
        uri: "codeg://assistant/3",
        meta: { assistantId: 3 },
      },
      {
        refType: "assistant",
        id: "4",
        label: "Planner",
        uri: "codeg://assistant/4",
        meta: { assistantId: 4 },
      },
    ])
    // The description, or the agent it runs on when there is none.
    expect(items.map((i) => i.detail)).toEqual(["Reviews diffs", "Codex"])
  })

  it("offers only the assistants that can be delegated to", () => {
    const groups = buildReferenceGroups(
      "",
      emptySources({
        agents: [makeAgent("codex"), makeAgent("gemini", { enabled: false })],
        assistants: [
          makeAssistant(1, "Live"),
          makeAssistant(2, "Switched off", { enabled: false }),
          makeAssistant(3, "On a disabled agent", { agent_type: "gemini" }),
          makeAssistant(4, "On an unknown agent", { agent_type: "grok" }),
          makeAssistant(5, "Deleted", {
            deleted_at: "2026-10-16T01:00:00Z",
          }),
        ],
      })
    )
    expect(itemsOf(groups, "assistant").map((i) => i.reference.label)).toEqual([
      "Live",
    ])
  })

  it("finds an assistant by its name, description or agent", () => {
    const sources = emptySources({
      agents: [makeAgent("codex"), makeAgent("open_code")],
      assistants: [
        makeAssistant(1, "Reviewer", { description: "Reads diffs" }),
        makeAssistant(2, "Planner", { agent_type: "open_code" }),
      ],
    })
    const labels = (query: string) =>
      itemsOf(buildReferenceGroups(query, sources), "assistant").map(
        (i) => i.reference.label
      )
    expect(labels("review")).toEqual(["Reviewer"])
    expect(labels("diffs")).toEqual(["Reviewer"])
    expect(labels("opencode")).toEqual(["Planner"])
    expect(labels("open_code")).toEqual(["Planner"])
  })

  it("adapts sessions into codeg://session references", () => {
    const groups = buildReferenceGroups(
      "login",
      emptySources({
        sessions: [
          makeConversation(7, "Login refactor"),
          makeConversation(8, "Sidebar perf"),
        ],
      })
    )
    const sessions = itemsOf(groups, "session")
    expect(sessions).toHaveLength(1)
    expect(sessions[0].reference.uri).toBe("codeg://session/7")
  })

  it("omits the commit group when there is no repoKey (R8)", () => {
    const groups = buildReferenceGroups(
      "",
      emptySources({ commits: [makeCommit("abc1234")], repoKey: null })
    )
    expect(itemsOf(groups, "commit")).toHaveLength(0)
  })

  it("adapts commits and filters by hash / message / author", () => {
    const groups = buildReferenceGroups(
      "bugfix",
      emptySources({
        commits: [
          makeCommit("abc1234", "bugfix: crash"),
          makeCommit("def5678", "feature"),
        ],
        repoKey: "/repo",
      })
    )
    const commits = itemsOf(groups, "commit")
    expect(commits).toHaveLength(1)
    expect(commits[0].reference.uri).toBe("codeg://commit/%2Frepo@abc12340000")
  })

  it("caps each group at 50 items and flags the overflow as truncated", () => {
    const files = Array.from({ length: 60 }, (_, i) => makeFile(`f${i}.ts`))
    const groups = buildReferenceGroups(
      "",
      emptySources({ files, workspaceRoot: "/repo" })
    )
    const fileGroup = groups.find((g) => g.kind === "file")
    expect(fileGroup?.items).toHaveLength(50)
    expect(fileGroup?.truncated).toBe(true)
  })

  it("does not flag truncation when a group exactly fills the cap", () => {
    const files = Array.from({ length: 50 }, (_, i) => makeFile(`f${i}.ts`))
    const groups = buildReferenceGroups(
      "",
      emptySources({ files, workspaceRoot: "/repo" })
    )
    const fileGroup = groups.find((g) => g.kind === "file")
    expect(fileGroup?.items).toHaveLength(50)
    expect(fileGroup?.truncated).toBe(false)
  })

  it("flags truncation for slice-based groups (agents) as well", () => {
    const agents = Array.from({ length: 51 }, (_, i) => makeAgent(`a${i}`))
    const groups = buildReferenceGroups("", emptySources({ agents }))
    const agentGroup = groups.find((g) => g.kind === "agent")
    expect(agentGroup?.items).toHaveLength(50)
    expect(agentGroup?.truncated).toBe(true)
  })

  it("returns everything for an empty query (whitespace-trimmed)", () => {
    const groups = buildReferenceGroups(
      "   ",
      emptySources({
        agents: [makeAgent("codex"), makeAgent("gemini")],
      })
    )
    expect(itemsOf(groups, "agent")).toHaveLength(2)
  })
})

// --- hook --------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  agents: [] as AcpAgentInfo[],
  files: { allFiles: [] as FlatFileEntry[], loaded: false },
  listAllConversations: vi.fn(),
  gitLog: vi.fn(),
}))

vi.mock("@/hooks/use-file-tree", () => ({
  useFileTree: () => ({
    allFiles: mocks.files.allFiles,
    loaded: mocks.files.loaded,
    loading: false,
    reset: () => {},
  }),
}))
vi.mock("@/hooks/use-acp-agents", () => ({
  useAcpAgents: () => ({ agents: mocks.agents, fresh: true, refresh: vi.fn() }),
}))
vi.mock("@/lib/api", () => ({
  listAllConversations: (...args: unknown[]) =>
    mocks.listAllConversations(...args),
  gitLog: (...args: unknown[]) => mocks.gitLog(...args),
}))

describe("useReferenceSearch", () => {
  beforeEach(() => {
    resetAssistantsStore()
    mocks.agents = []
    mocks.files = { allFiles: [], loaded: false }
    mocks.listAllConversations.mockReset().mockResolvedValue([])
    mocks.gitLog
      .mockReset()
      .mockResolvedValue({ entries: [], has_upstream: false })
  })

  it("returns a referentially stable search across data-source updates (R7)", async () => {
    mocks.agents = [makeAgent("codex", { name: "Codex" })]
    const { result, rerender } = renderHook(
      (props: { enabled: boolean }) => useReferenceSearch(props),
      { initialProps: { enabled: true } }
    )
    const first = result.current

    // A background refresh swaps the agents array reference.
    mocks.agents = [
      makeAgent("codex", { name: "Codex" }),
      makeAgent("gemini", { name: "Gemini" }),
    ]
    rerender({ enabled: true })

    // Identity is unchanged — the popup will not re-fetch or reset selection…
    expect(result.current).toBe(first)
    // …yet the stable function reads the freshest data through its refs.
    let groups!: SuggestionGroup[]
    await act(async () => {
      groups = (await result.current("")) as SuggestionGroup[]
    })
    expect(itemsOf(groups, "agent")).toHaveLength(2)
  })

  it("lazily fetches and awaits sessions + commits on the first search", async () => {
    mocks.listAllConversations.mockResolvedValue([
      makeConversation(7, "Login refactor"),
    ])
    mocks.gitLog.mockResolvedValue({
      entries: [makeCommit("abc1234", "fix")],
      has_upstream: false,
    })
    mocks.files = { allFiles: [makeFile("a.ts")], loaded: true }

    const { result } = renderHook(() =>
      useReferenceSearch({ defaultPath: "/repo", enabled: true })
    )
    let groups!: SuggestionGroup[]
    await act(async () => {
      groups = (await result.current("")) as SuggestionGroup[]
    })

    expect(mocks.listAllConversations).toHaveBeenCalledTimes(1)
    expect(mocks.gitLog).toHaveBeenCalledWith("/repo", 100)
    expect(itemsOf(groups, "session")).toHaveLength(1)
    expect(itemsOf(groups, "commit")).toHaveLength(1)
    expect(itemsOf(groups, "file")).toHaveLength(1)
  })

  it("reuses the cached network promises across repeated searches", async () => {
    const { result } = renderHook(() =>
      useReferenceSearch({ defaultPath: "/repo", enabled: true })
    )
    await act(async () => {
      await result.current("")
      await result.current("a")
      await result.current("ab")
    })
    expect(mocks.listAllConversations).toHaveBeenCalledTimes(1)
    expect(mocks.gitLog).toHaveBeenCalledTimes(1)
  })

  it("resolves to no groups and touches no network when disabled", async () => {
    const { result } = renderHook(() =>
      useReferenceSearch({ defaultPath: "/repo", enabled: false })
    )
    let groups!: SuggestionGroup[]
    await act(async () => {
      groups = (await result.current("x")) as SuggestionGroup[]
    })
    expect(groups).toEqual([])
    expect(mocks.listAllConversations).not.toHaveBeenCalled()
    expect(mocks.gitLog).not.toHaveBeenCalled()
  })

  it("returns no groups when the query is aborted mid-fetch", async () => {
    mocks.listAllConversations.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve([makeConversation(1, "x")]), 10)
        )
    )
    const { result } = renderHook(() =>
      useReferenceSearch({ defaultPath: "/repo", enabled: true })
    )
    let groups!: SuggestionGroup[]
    await act(async () => {
      const controller = new AbortController()
      const pending = result.current("", controller.signal)
      controller.abort()
      groups = (await pending) as SuggestionGroup[]
    })
    expect(groups).toEqual([])
  })

  it("degrades gracefully with no workspace path: agents resolve, files/commits stay empty (R8)", async () => {
    mocks.agents = [makeAgent("codex", { name: "Codex" })]
    mocks.files = { allFiles: [makeFile("a.ts")], loaded: true }

    const { result } = renderHook(() => useReferenceSearch({ enabled: true }))
    let groups!: SuggestionGroup[]
    await act(async () => {
      groups = (await result.current("")) as SuggestionGroup[]
    })

    expect(itemsOf(groups, "file")).toHaveLength(0)
    expect(itemsOf(groups, "commit")).toHaveLength(0)
    expect(itemsOf(groups, "agent")).toHaveLength(1)
    expect(mocks.gitLog).not.toHaveBeenCalled()
  })

  it("does not leak the previous folder's commits when defaultPath changes mid-fetch", async () => {
    // git-log for repo A hangs until we resolve it by hand; repo B resolves
    // immediately. We switch folders before A resolves.
    let resolveA!: (value: {
      entries: GitLogEntry[]
      has_upstream: boolean
    }) => void
    mocks.gitLog.mockImplementation((repoPath: string) => {
      if (repoPath === "/repoA") {
        return new Promise((resolve) => {
          resolveA = resolve
        })
      }
      return Promise.resolve({
        entries: [makeCommit("bbb", "repo B commit")],
        has_upstream: false,
      })
    })

    const { result, rerender } = renderHook(
      (props: { defaultPath: string }) =>
        useReferenceSearch({ defaultPath: props.defaultPath, enabled: true }),
      { initialProps: { defaultPath: "/repoA" } }
    )

    // Start a search that hangs on gitLog("/repoA").
    let pending!: SuggestionGroup[] | Promise<SuggestionGroup[]>
    await act(async () => {
      pending = result.current("")
    })

    // The composer switches to repo B; commit flushes the ref mirror (pathRef →
    // "/repoB") before the stale repo A fetch resolves.
    //
    // NOTE: jsdom + RTL `act()` flush BOTH layout and passive effects at their
    // boundaries, so a unit test cannot reproduce the real-browser window where
    // a passive effect lags behind a macrotask that resolves the stale promise.
    // This asserts the guard CONTRACT (a folder switch discards the stale
    // result); the production fix that closes the timing window is the
    // commit-synchronous layout-effect mirror of pathRef in the hook.
    await act(async () => {
      rerender({ defaultPath: "/repoB" })
    })

    let groups!: SuggestionGroup[]
    await act(async () => {
      resolveA({
        entries: [makeCommit("aaa", "repo A commit")],
        has_upstream: false,
      })
      groups = (await pending) as SuggestionGroup[]
    })

    // The stale invocation must not render repo A commits into repo B's panel;
    // it bails so the next keystroke re-queries the current folder.
    expect(groups).toEqual([])
  })

  it("loads nothing for the tabs the panel isn't showing", async () => {
    mocks.agents = [makeAgent("codex", { name: "Codex" })]
    mocks.files = { allFiles: [makeFile("a.ts")], loaded: true }
    mocks.listAllConversations.mockResolvedValue([makeConversation(1, "x")])
    mocks.gitLog.mockResolvedValue({
      entries: [makeCommit("abc1234")],
      has_upstream: false,
    })

    const { result } = renderHook(() =>
      useReferenceSearch({ defaultPath: "/repo", enabled: true })
    )
    let groups!: SuggestionGroup[]
    await act(async () => {
      groups = (await result.current("", undefined, [
        "file",
      ])) as SuggestionGroup[]
    })

    // Sessions and commits were hidden: neither request goes out.
    expect(mocks.listAllConversations).not.toHaveBeenCalled()
    expect(mocks.gitLog).not.toHaveBeenCalled()
    expect(itemsOf(groups, "file")).toHaveLength(1)
    expect(itemsOf(groups, "agent")).toHaveLength(0)
    expect(itemsOf(groups, "assistant")).toHaveLength(0)
    expect(itemsOf(groups, "session")).toHaveLength(0)
    expect(itemsOf(groups, "commit")).toHaveLength(0)
    // Still every group, so the provider's shape doesn't depend on the tabs.
    expect(groups.map((g) => g.kind)).toEqual([
      "file",
      "agent",
      "assistant",
      "session",
      "commit",
    ])
  })

  it("reads the assistants from the store, and live", async () => {
    mocks.agents = [makeAgent("codex", { name: "Codex" })]
    useAssistantsStore.getState().merge([makeAssistant(3, "Reviewer")])
    const { result } = renderHook(() =>
      useReferenceSearch({ defaultPath: null, enabled: true })
    )
    const search = result.current
    let groups!: SuggestionGroup[]
    await act(async () => {
      groups = (await search("", undefined, ["assistant"])) as SuggestionGroup[]
    })
    expect(itemsOf(groups, "assistant").map((i) => i.reference.id)).toEqual([
      "3",
    ])
    // Only the shown tabs are adapted: the agent tab is hidden here.
    expect(itemsOf(groups, "agent")).toHaveLength(0)

    act(() => {
      useAssistantsStore.getState().merge([makeAssistant(4, "Planner")])
    })
    // Same search function, fresh rows.
    expect(result.current).toBe(search)
    await act(async () => {
      groups = (await search("", undefined, ["assistant"])) as SuggestionGroup[]
    })
    expect(itemsOf(groups, "assistant").map((i) => i.reference.id)).toEqual([
      "3",
      "4",
    ])
  })

  it("keeps the git-log cache while the commit tab is hidden", async () => {
    mocks.gitLog.mockResolvedValue({
      entries: [makeCommit("abc1234")],
      has_upstream: false,
    })
    const { result } = renderHook(() =>
      useReferenceSearch({ defaultPath: "/repo", enabled: true })
    )
    let shownAgain!: SuggestionGroup[]
    await act(async () => {
      await result.current("")
      await result.current("", undefined, ["agent", "file"])
      shownAgain = (await result.current("", undefined, [
        "agent",
        "file",
        "commit",
      ])) as SuggestionGroup[]
    })
    // Hiding the tab didn't throw away what was already loaded…
    expect(mocks.gitLog).toHaveBeenCalledTimes(1)
    // …so switching it back on shows it straight away.
    expect(itemsOf(shownAgain, "commit")).toHaveLength(1)
  })

  it("retries a lazy fetch after it rejects (a failure is never cached)", async () => {
    mocks.listAllConversations
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce([makeConversation(1, "Recovered")])

    const { result } = renderHook(() => useReferenceSearch({ enabled: true }))

    let first!: SuggestionGroup[]
    await act(async () => {
      first = (await result.current("")) as SuggestionGroup[]
    })
    // First fetch rejected → the session group is empty, but the others render.
    expect(itemsOf(first, "session")).toHaveLength(0)

    let second!: SuggestionGroup[]
    await act(async () => {
      second = (await result.current("")) as SuggestionGroup[]
    })
    // The failure was not cached, so the second `@` issues a fresh request…
    expect(mocks.listAllConversations).toHaveBeenCalledTimes(2)
    // …which succeeds and populates the group.
    expect(itemsOf(second, "session")).toHaveLength(1)
  })
})
