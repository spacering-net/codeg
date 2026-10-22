import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { toast } from "sonner"
import { describe, expect, it, vi } from "vitest"

import {
  capChangeTreeToBudget,
  type ChangeTreeNode,
  countVisibleChangeRows,
  GitChangesTab,
  MAX_VISIBLE_ROWS,
} from "./aux-panel-git-changes-tab"
import enMessages from "@/i18n/messages/en.json"

// ---------------------------------------------------------------------------
// Pure helpers — the cap algorithm, tested without React.
// ---------------------------------------------------------------------------

const file = (name: string, path = name): ChangeTreeNode => ({
  kind: "file",
  name,
  path,
  change: { path, status: "M", additions: 0, deletions: 0 },
})

const dir = (
  name: string,
  children: ChangeTreeNode[],
  path = name
): ChangeTreeNode => ({ kind: "dir", name, path, children, fileCount: 0 })

describe("countVisibleChangeRows", () => {
  it("counts one row per flat file", () => {
    expect(
      countVisibleChangeRows([file("a"), file("b"), file("c")], new Set())
    ).toBe(3)
  })

  it("does not count a collapsed directory's children", () => {
    const tree = [dir("A", [file("A/1", "A/1"), file("A/2", "A/2")], "A")]
    // A collapsed → only A's own row counts.
    expect(countVisibleChangeRows(tree, new Set())).toBe(1)
  })

  it("counts an expanded directory's children", () => {
    const tree = [dir("A", [file("A/1", "A/1"), file("A/2", "A/2")], "A")]
    expect(countVisibleChangeRows(tree, new Set(["A"]))).toBe(3)
  })

  it("recurses only through the expanded path", () => {
    const tree = [
      dir(
        "A",
        [dir("B", [file("A/B/1", "A/B/1")], "A/B"), file("A/2", "A/2")],
        "A"
      ),
    ]
    // A expanded, B collapsed: A + B + A/2 = 3 (B's child hidden).
    expect(countVisibleChangeRows(tree, new Set(["A"]))).toBe(3)
    // Both expanded: A + B + A/B/1 + A/2 = 4.
    expect(countVisibleChangeRows(tree, new Set(["A", "A/B"]))).toBe(4)
  })
})

describe("capChangeTreeToBudget", () => {
  it("keeps only the first `budget` rows in display order", () => {
    const nodes = [file("a"), file("b"), file("c"), file("d"), file("e")]
    const { nodes: capped, remaining } = capChangeTreeToBudget(
      nodes,
      new Set(),
      2
    )
    expect(capped.map((n) => n.name)).toEqual(["a", "b"])
    expect(remaining).toBe(0)
  })

  it("keeps a collapsed directory's children intact without spending budget on them", () => {
    const big = dir(
      "A",
      Array.from({ length: 10 }, (_, i) => file(`A/${i}`, `A/${i}`)),
      "A"
    )
    const nodes = [big, file("x"), file("y")]
    // A is collapsed (not in the expanded set): A, x, y = 3 rows fit the budget.
    const { nodes: capped, remaining } = capChangeTreeToBudget(
      nodes,
      new Set(),
      3
    )
    expect(capped).toHaveLength(3)
    const first = capped[0]
    expect(first.kind).toBe("dir")
    // Children are preserved so expanding the directory later still works.
    expect(first.kind === "dir" && first.children).toHaveLength(10)
    expect(remaining).toBe(0)
  })

  it("spends budget on an expanded directory's children", () => {
    const tree = [
      dir(
        "A",
        [file("A/1", "A/1"), file("A/2", "A/2"), file("A/3", "A/3")],
        "A"
      ),
    ]
    // Budget 2: the directory row + its first child.
    const { nodes: capped } = capChangeTreeToBudget(tree, new Set(["A"]), 2)
    expect(capped).toHaveLength(1)
    const only = capped[0]
    expect(only.kind === "dir" && only.children.map((c) => c.name)).toEqual([
      "A/1",
    ])
  })

  it("returns everything when the budget exceeds the total", () => {
    const nodes = [file("a"), file("b"), file("c")]
    const { nodes: capped, remaining } = capChangeTreeToBudget(
      nodes,
      new Set(),
      10
    )
    expect(capped).toHaveLength(3)
    expect(remaining).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// Component — the cap wiring, with Radix trees mocked to lightweight
// passthroughs so we can render hundreds of rows cheaply. The cap logic is
// independent of the file-tree / context-menu internals.
// ---------------------------------------------------------------------------

const store = vi.hoisted(() => ({
  git: [] as {
    path: string
    status: string
    additions: number
    deletions: number
  }[],
}))

const gitCommitMock = vi.hoisted(() =>
  vi.fn(async () => ({ committed_files: 1 }))
)
const generateMock = vi.hoisted(() => vi.fn())
const cancelGenerateMock = vi.hoisted(() => vi.fn(async () => {}))

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  gitCommit: gitCommitMock,
  gitGenerateCommitMessage: generateMock,
  gitGenerateCommitMessageCancel: cancelGenerateMock,
}))

vi.mock("@/hooks/use-workspace-state-store", () => ({
  useWorkspaceStateStore: () => ({
    rootPath: "/repo",
    seq: 1,
    version: 1,
    health: "healthy",
    tree: [],
    git: store.git,
    error: null,
    degraded: false,
    isGitRepo: true,
    requestResync: async () => {},
    restart: async () => {},
    subscribeEnvelopes: () => () => {},
  }),
}))

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: { id: "f1", path: "/repo" } }),
}))

// The toolbar's git operations pull in the task/alert/credential contexts and
// the workspace store, none of which this cap-focused suite provides. Stub the
// hook out — the toolbar itself is inert here.
vi.mock("@/hooks/use-git-quick-actions", () => ({
  useGitQuickActions: () => ({
    running: false,
    runGitTask: vi.fn(),
    pull: vi.fn(),
    fetchAll: vi.fn(),
    updateBranch: vi.fn(),
    reportConflict: vi.fn(),
    openCommitWindow: vi.fn(),
    openPushWindow: vi.fn(),
    openStashDialog: vi.fn(),
    openUnstashWindow: vi.fn(),
    dialogs: null,
  }),
}))

vi.mock("@/contexts/tab-context", () => ({
  useTabStore: (selector: (s: { tabs: []; activeTabId: null }) => unknown) =>
    selector({ tabs: [], activeTabId: null }),
}))

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({
    openFilePreview: vi.fn(),
    openWorkingTreeDiff: vi.fn(),
  }),
}))

// Radix context menu → passthrough trigger, no lazy content.
vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  ContextMenuContent: () => null,
  ContextMenuItem: () => null,
}))

// File tree → render name + children directly (expansion is irrelevant to the
// cap for a flat root, and the component already passes pre-capped nodes).
vi.mock("@/components/ai-elements/file-tree", () => ({
  FileTree: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  FileTreeFolder: ({
    name,
    suffix,
    children,
  }: {
    name: string
    suffix?: React.ReactNode
    children: React.ReactNode
  }) => (
    <div>
      <span>{name}</span>
      {suffix}
      {children}
    </div>
  ),
  FileTreeFile: ({
    name,
    children,
  }: {
    name: string
    children?: React.ReactNode
  }) => <div>{children ?? name}</div>,
}))

function id(n: number): string {
  return `f${String(n).padStart(4, "0")}`
}

function flatGit(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    path: id(i + 1),
    status: "M",
    additions: 1,
    deletions: 0,
  }))
}

function renderTab() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <GitChangesTab />
    </NextIntlClientProvider>
  )
}

describe("GitChangesTab render cap", () => {
  it("renders every row and no reveal control for a small change set", () => {
    store.git = flatGit(3)
    renderTab()

    expect(screen.getByText("f0001")).toBeInTheDocument()
    expect(screen.getByText("f0003")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /more items/ })
    ).not.toBeInTheDocument()
  })

  it("builds an expanded directory's children", () => {
    // Tracked changes auto-expand every directory, so the nested files render.
    store.git = [
      { path: "pkg/a", status: "M", additions: 1, deletions: 0 },
      { path: "pkg/b", status: "M", additions: 1, deletions: 0 },
    ]
    renderTab()

    expect(screen.getByText("pkg")).toBeInTheDocument()
    expect(screen.getByText("a")).toBeInTheDocument()
    expect(screen.getByText("b")).toBeInTheDocument()
  })

  it("does not build a collapsed directory's children", () => {
    // Untracked changes default to a collapsed tree. The folder row renders,
    // but its children must not be constructed until it is expanded — otherwise
    // a huge collapsed subtree would still build thousands of elements.
    store.git = [
      { path: "pkg/a", status: "??", additions: 0, deletions: 0 },
      { path: "pkg/b", status: "??", additions: 0, deletions: 0 },
      { path: "pkg/c", status: "??", additions: 0, deletions: 0 },
    ]
    renderTab()

    expect(screen.getByText("pkg")).toBeInTheDocument()
    expect(screen.queryByText("a")).not.toBeInTheDocument()
    expect(screen.queryByText("c")).not.toBeInTheDocument()
  })

  it("caps a large change set and offers to reveal the rest", () => {
    const hidden = 50
    store.git = flatGit(MAX_VISIBLE_ROWS + hidden)
    renderTab()

    expect(screen.getByText(id(MAX_VISIBLE_ROWS))).toBeInTheDocument()
    expect(screen.queryByText(id(MAX_VISIBLE_ROWS + 1))).not.toBeInTheDocument()
    expect(
      screen.queryByText(id(MAX_VISIBLE_ROWS + hidden))
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: `Show ${hidden} more items` })
    ).toBeInTheDocument()
  })

  it("reveals all rows once expanded", () => {
    const hidden = 50
    store.git = flatGit(MAX_VISIBLE_ROWS + hidden)
    renderTab()

    fireEvent.click(
      screen.getByRole("button", { name: `Show ${hidden} more items` })
    )

    expect(screen.getByText(id(MAX_VISIBLE_ROWS + hidden))).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /more items/ })
    ).not.toBeInTheDocument()
  })

  it("re-caps when a fresh, larger change set replaces the revealed one", () => {
    store.git = flatGit(MAX_VISIBLE_ROWS + 50)
    const { rerender } = renderTab()
    fireEvent.click(screen.getByRole("button", { name: "Show 50 more items" }))
    expect(screen.getByText(id(MAX_VISIBLE_ROWS + 50))).toBeInTheDocument()

    // A different, larger snapshot arrives (new git array identity). The reveal
    // must reset so the panel re-caps instead of mounting the whole tree.
    store.git = flatGit(MAX_VISIBLE_ROWS + 120)
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <GitChangesTab />
      </NextIntlClientProvider>
    )

    expect(
      screen.getByRole("button", { name: "Show 120 more items" })
    ).toBeInTheDocument()
    expect(screen.getByText(id(MAX_VISIBLE_ROWS))).toBeInTheDocument()
    expect(
      screen.queryByText(id(MAX_VISIBLE_ROWS + 120))
    ).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Quick-commit toolbar — the Enter that confirms a CJK candidate is the IME's,
// not a commit. WebKit ends the composition before dispatching that keydown, so
// `isComposing` is already false there and only the 229 sentinel marks it.
// ---------------------------------------------------------------------------

describe("GitChangesTab quick commit IME guard", () => {
  const PLACEHOLDER = "Commit message (Enter to commit)"

  function typeMessage() {
    store.git = flatGit(1)
    gitCommitMock.mockClear()
    renderTab()
    const input = screen.getByPlaceholderText(PLACEHOLDER)
    fireEvent.change(input, { target: { value: "修复提交" } })
    return input
  }

  it("does not commit on the candidate-confirming Enter (WebKit: keyCode 229)", () => {
    const input = typeMessage()
    fireEvent.compositionStart(input)
    fireEvent.compositionEnd(input)
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 })
    expect(gitCommitMock).not.toHaveBeenCalled()
  })

  it("does not commit while a composition is still open", () => {
    const input = typeMessage()
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: "Enter" })
    expect(gitCommitMock).not.toHaveBeenCalled()
  })

  it("still commits on a deliberate Enter", async () => {
    const input = typeMessage()
    fireEvent.compositionStart(input)
    fireEvent.compositionEnd(input)
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 })
    // Awaited inside act so the commit's post-await state updates settle here.
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
    })
    expect(gitCommitMock).toHaveBeenCalledTimes(1)
    expect(gitCommitMock).toHaveBeenCalledWith(
      "/repo",
      "修复提交",
      ["f0001"],
      "f1"
    )
  })
})

// ---------------------------------------------------------------------------
// Quick-commit box: multi-line, and the ✨ that writes its message.
// ---------------------------------------------------------------------------

type Generated = { message: string; agent_type: string; auto_commit: boolean }

describe("GitChangesTab commit message box", () => {
  const PLACEHOLDER = "Commit message (Enter to commit)"
  const GENERATE = "Generate a commit message"

  function setup(count = 2) {
    store.git = flatGit(count)
    gitCommitMock.mockClear()
    generateMock.mockReset()
    cancelGenerateMock.mockClear()
    renderTab()
    return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement
  }

  it("starts a new line on Shift+Enter instead of committing", () => {
    const box = setup()
    fireEvent.change(box, { target: { value: "fix: a" } })
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true })
    expect(gitCommitMock).not.toHaveBeenCalled()
  })

  it("commits a multi-line message whole", async () => {
    const box = setup(1)
    fireEvent.change(box, { target: { value: "fix: a\n\nbecause b" } })
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" })
    })
    expect(gitCommitMock).toHaveBeenCalledWith(
      "/repo",
      "fix: a\n\nbecause b",
      ["f0001"],
      "f1"
    )
  })

  it("fills the box with a message written for the tracked changes", async () => {
    const box = setup()
    fireEvent.change(box, { target: { value: "parser" } })
    let finish!: (value: Generated) => void
    generateMock.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    fireEvent.click(screen.getByRole("button", { name: GENERATE }))
    expect(generateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/repo",
        folderId: "f1",
        files: ["f0001", "f0002"],
        draft: "parser",
        fallbackAgent: null,
      })
    )
    // Read-only while it is written, and Enter does not commit the draft.
    expect(box.readOnly).toBe(true)
    fireEvent.keyDown(box, { key: "Enter" })
    expect(gitCommitMock).not.toHaveBeenCalled()

    await act(async () => {
      finish({
        message: "fix(parser): keep quotes\n\nThey were dropped.",
        agent_type: "claude_code",
        auto_commit: false,
      })
    })
    expect(box.value).toBe("fix(parser): keep quotes\n\nThey were dropped.")
    expect(box.readOnly).toBe(false)
  })

  it("stops on a second click and keeps the draft", async () => {
    const box = setup()
    fireEvent.change(box, { target: { value: "draft" } })
    let finish!: (value: Generated) => void
    generateMock.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    fireEvent.click(screen.getByRole("button", { name: GENERATE }))
    const requestId = generateMock.mock.calls[0][0].requestId
    fireEvent.click(screen.getByRole("button", { name: /Stop generating/ }))
    expect(cancelGenerateMock).toHaveBeenCalledWith(requestId)
    await act(async () => {
      finish({
        message: "too late",
        agent_type: "claude_code",
        auto_commit: false,
      })
    })
    expect(box.value).toBe("draft")
  })

  it("commits what the message was written for when the settings say so", async () => {
    const box = setup()
    generateMock.mockResolvedValueOnce({
      message: "fix: both",
      agent_type: "claude_code",
      auto_commit: true,
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: GENERATE }))
    })
    expect(gitCommitMock).toHaveBeenCalledWith(
      "/repo",
      "fix: both",
      ["f0001", "f0002"],
      "f1"
    )
    expect(box.value).toBe("")
  })

  it("only fills the box when the changes moved while it was written", async () => {
    store.git = flatGit(2)
    gitCommitMock.mockClear()
    generateMock.mockReset()
    const view = renderTab()
    let finish!: (value: Generated) => void
    generateMock.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    fireEvent.click(screen.getByRole("button", { name: GENERATE }))
    store.git = flatGit(3)
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <GitChangesTab />
      </NextIntlClientProvider>
    )
    await act(async () => {
      finish({
        message: "fix: two",
        agent_type: "claude_code",
        auto_commit: true,
      })
    })
    expect(gitCommitMock).not.toHaveBeenCalled()
    expect(
      (screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement).value
    ).toBe("fix: two")
  })

  it("has nothing to describe without any changes", () => {
    setup(0)
    const button = screen.getByRole("button", {
      name: "No changes to describe",
    })
    expect(button).toBeDisabled()
  })
})

// ---------------------------------------------------------------------------
// Untracked files: the ✨ asks which of them go with the message, and Enter
// commits the ones kept checked along with the tracked changes.
// ---------------------------------------------------------------------------

describe("GitChangesTab untracked files and the ✨", () => {
  const PLACEHOLDER = "Commit message (Enter to commit)"
  const GENERATE = "Generate a commit message"
  const DROP = "Don't commit the untracked files"

  const tracked = { path: "f0001", status: "M", additions: 1, deletions: 0 }
  const untracked = (path: string) => ({
    path,
    status: "??",
    additions: 0,
    deletions: 0,
  })

  function setup(
    git = [tracked, untracked("new/a.ts"), untracked("new/b.ts")]
  ) {
    store.git = git
    gitCommitMock.mockClear()
    generateMock.mockReset()
    const view = renderTab()
    const box = screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement
    return { view, box }
  }

  function rerenderTab(view: ReturnType<typeof renderTab>) {
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <GitChangesTab />
      </NextIntlClientProvider>
    )
  }

  const checkbox = (name: string) => screen.getByRole("checkbox", { name })

  // Ask, leave `new/b.ts` out, and have the message written.
  async function generateWithoutB(message: string, autoCommit = false) {
    generateMock.mockResolvedValueOnce({
      message,
      agent_type: "claude_code",
      auto_commit: autoCommit,
    })
    fireEvent.click(screen.getByRole("button", { name: GENERATE }))
    fireEvent.click(checkbox("new/b.ts"))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Generate" }))
    })
  }

  it("asks first, every untracked file checked, and describes the kept ones", async () => {
    setup()
    fireEvent.click(screen.getByRole("button", { name: GENERATE }))

    expect(generateMock).not.toHaveBeenCalled()
    expect(checkbox("new/a.ts")).toHaveAttribute("aria-checked", "true")
    expect(checkbox("new/b.ts")).toHaveAttribute("aria-checked", "true")

    fireEvent.click(checkbox("new/b.ts"))
    generateMock.mockReturnValueOnce(new Promise(() => {}))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Generate" }))
    })
    expect(generateMock).toHaveBeenCalledWith(
      expect.objectContaining({ files: ["f0001", "new/a.ts"] })
    )
  })

  it("commits the kept untracked files with the message on Enter", async () => {
    const { box } = setup()
    await generateWithoutB("feat: add a")

    expect(box.value).toBe("feat: add a")
    expect(
      screen.getByText("Also commits 1 untracked file")
    ).toBeInTheDocument()
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" })
    })
    expect(gitCommitMock).toHaveBeenCalledWith(
      "/repo",
      "feat: add a",
      ["f0001", "new/a.ts"],
      "f1"
    )
    // Committed: the next commit is asked about afresh.
    expect(screen.queryByText(/Also commits/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: GENERATE }))
    expect(checkbox("new/b.ts")).toHaveAttribute("aria-checked", "true")
  })

  it("commits them right away when the settings say so", async () => {
    setup()
    await generateWithoutB("feat: add a", true)
    expect(gitCommitMock).toHaveBeenCalledWith(
      "/repo",
      "feat: add a",
      ["f0001", "new/a.ts"],
      "f1"
    )
  })

  it("keeps a file left out unchecked the next time it asks", async () => {
    setup()
    await generateWithoutB("feat: add a")

    fireEvent.click(screen.getByRole("button", { name: GENERATE }))
    expect(checkbox("new/a.ts")).toHaveAttribute("aria-checked", "true")
    expect(checkbox("new/b.ts")).toHaveAttribute("aria-checked", "false")
  })

  it("drops the kept files on request, leaving Enter the tracked changes", async () => {
    const { box } = setup()
    await generateWithoutB("feat: add a")

    fireEvent.click(screen.getByRole("button", { name: DROP }))
    expect(screen.queryByText(/Also commits/)).not.toBeInTheDocument()
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" })
    })
    expect(gitCommitMock).toHaveBeenCalledWith(
      "/repo",
      "feat: add a",
      ["f0001"],
      "f1"
    )
  })

  it("writes nothing when the dialog is cancelled", () => {
    setup()
    fireEvent.click(screen.getByRole("button", { name: GENERATE }))
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    expect(generateMock).not.toHaveBeenCalled()
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
    expect(screen.queryByText(/Also commits/)).not.toBeInTheDocument()
  })

  it("describes untracked files alone when nothing tracked changed", async () => {
    setup([untracked("new/a.ts"), untracked("new/b.ts")])
    fireEvent.click(screen.getByRole("button", { name: GENERATE }))
    generateMock.mockReturnValueOnce(new Promise(() => {}))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Generate" }))
    })
    expect(generateMock).toHaveBeenCalledWith(
      expect.objectContaining({ files: ["new/a.ts", "new/b.ts"] })
    )
  })

  it("leaves out a file deleted while the dialog was open", async () => {
    const { view } = setup()
    fireEvent.click(screen.getByRole("button", { name: GENERATE }))
    store.git = [tracked, untracked("new/a.ts")]
    rerenderTab(view)

    generateMock.mockReturnValueOnce(new Promise(() => {}))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Generate" }))
    })
    expect(generateMock).toHaveBeenCalledWith(
      expect.objectContaining({ files: ["f0001", "new/a.ts"] })
    )
  })

  it("keeps the picks when the commit is refused, for the retry", async () => {
    const { box } = setup()
    await generateWithoutB("feat: add a")
    gitCommitMock.mockRejectedValueOnce(new Error("pre-commit hook failed"))
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" })
    })

    // The backend took them back out of the index: still untracked, still
    // picked, and the next Enter commits them.
    expect(box.value).toBe("feat: add a")
    expect(
      screen.getByText("Also commits 1 untracked file")
    ).toBeInTheDocument()
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" })
    })
    expect(gitCommitMock).toHaveBeenLastCalledWith(
      "/repo",
      "feat: add a",
      ["f0001", "new/a.ts"],
      "f1"
    )
  })

  it("says so when a file left unchecked was staged meanwhile", async () => {
    const info = vi.spyOn(toast, "info")
    const { view } = setup()
    fireEvent.click(screen.getByRole("button", { name: GENERATE }))
    fireEvent.click(checkbox("new/b.ts"))
    store.git = [
      tracked,
      untracked("new/a.ts"),
      { path: "new/b.ts", status: "A", additions: 1, deletions: 0 },
    ]
    rerenderTab(view)

    generateMock.mockReturnValueOnce(new Promise(() => {}))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Generate" }))
    })
    // Staged, it goes with the commit whatever the box said — and is described.
    expect(generateMock).toHaveBeenCalledWith(
      expect.objectContaining({ files: ["f0001", "new/b.ts", "new/a.ts"] })
    )
    expect(info).toHaveBeenCalledWith(
      "Some files you unchecked were staged in the meantime, so they're committed with the tracked changes",
      { description: "new/b.ts" }
    )
    info.mockRestore()
  })

  it("keeps a file left out unchecked through a time off the list", async () => {
    const { view } = setup()
    await generateWithoutB("feat: add a")

    // Ignored for a while: the next ask doesn't list it.
    store.git = [tracked, untracked("new/a.ts")]
    rerenderTab(view)
    generateMock.mockResolvedValueOnce({
      message: "feat: add a",
      agent_type: "claude_code",
      auto_commit: false,
    })
    fireEvent.click(screen.getByRole("button", { name: GENERATE }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Generate" }))
    })

    store.git = [tracked, untracked("new/a.ts"), untracked("new/b.ts")]
    rerenderTab(view)
    fireEvent.click(screen.getByRole("button", { name: GENERATE }))
    expect(checkbox("new/b.ts")).toHaveAttribute("aria-checked", "false")
  })

  it("only fills the box when a kept file went away while it was written", async () => {
    const { view, box } = setup()
    let finish!: (value: Generated) => void
    generateMock.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    fireEvent.click(screen.getByRole("button", { name: GENERATE }))
    fireEvent.click(checkbox("new/b.ts"))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Generate" }))
    })
    store.git = [tracked, untracked("new/b.ts")]
    rerenderTab(view)

    await act(async () => {
      finish({
        message: "feat: add a",
        agent_type: "claude_code",
        auto_commit: true,
      })
    })
    expect(gitCommitMock).not.toHaveBeenCalled()
    expect(box.value).toBe("feat: add a")
  })
})
