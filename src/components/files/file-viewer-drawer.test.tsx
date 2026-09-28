/**
 * The file viewer is a VIEW of the ordinary workspace file tab, not a second
 * file system. Everything below is about that relationship holding: it opens
 * through `openFilePreview`, it finds the tab that call created, it renders the
 * tab the way the file column would, and it can hand the user back to that
 * column.
 */
import { act, render, screen } from "@testing-library/react"
import { useEffect, useReducer } from "react"
import { describe, expect, it, vi, beforeEach } from "vitest"

import { FileViewerDrawer } from "./file-viewer-drawer"
import type { FileWorkspaceTab } from "@/contexts/workspace-context"
import { buildFileTabId } from "@/lib/file-tab-id"

const ABS_PATH = "/repo/docs/plan.md"
const TAB_ID = buildFileTabId({ kind: "file", path: ABS_PATH })

const {
  stableT,
  mockOpenFilePreview,
  mockSwitchFileTab,
  mockToggleFileTabPreview,
  mockOpenSessionFileDiff,
  mockOpenConversations,
  state,
} = vi.hoisted(() => ({
  stableT: (key: string) => key,
  mockOpenFilePreview: vi.fn(),
  mockSwitchFileTab: vi.fn(),
  mockToggleFileTabPreview: vi.fn(),
  mockOpenSessionFileDiff: vi.fn(),
  mockOpenConversations: vi.fn(),
  state: {
    fileTabs: [] as unknown[],
    previewFileTabIds: new Set<string>(),
    // The real slice is a subscription; a plain object would let a test swap
    // the tab set without the panel ever re-rendering, which is exactly the
    // transition the "tab closed out from under it" case is about.
    listeners: new Set<() => void>(),
  },
}))

vi.mock("next-intl", () => ({ useTranslations: () => stableT }))
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({
    openFilePreview: mockOpenFilePreview,
    openSessionFileDiff: mockOpenSessionFileDiff,
    switchFileTab: mockSwitchFileTab,
    toggleFileTabPreview: mockToggleFileTabPreview,
  }),
  useWorkspaceFileTabs: () => {
    const [, force] = useReducer((count: number) => count + 1, 0)
    useEffect(() => {
      state.listeners.add(force)
      return () => {
        state.listeners.delete(force)
      }
    }, [])
    return state
  },
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useOptionalWorkbenchRoute: () => ({
    routeId: "tasks",
    isConversations: false,
    setRoute: vi.fn(),
    openConversations: mockOpenConversations,
  }),
}))
vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: (select: (s: unknown) => unknown) =>
    select({ allFolders: [{ id: 1, path: "/repo" }] }),
}))

// The renderers are the file column's, already covered by its own tests —
// here they only need to report which branch the drawer picked, and with what.
vi.mock("@/components/files/markdown-document-preview", () => ({
  MarkdownDocumentPreview: ({
    content,
    fileDir,
    previewRoot,
    openFilePreview,
  }: {
    content: string
    fileDir: string | null
    previewRoot: string | null
    openFilePreview: (path: string) => void
  }) => (
    <div
      data-testid="markdown"
      data-file-dir={fileDir ?? ""}
      data-preview-root={previewRoot ?? ""}
    >
      {content}
      {/* Stands in for a link in the document: the preview pre-resolves local
          hrefs to absolute paths before handing them to this callback. */}
      <button
        type="button"
        onClick={() => openFilePreview("/repo/docs/spec.md")}
      >
        follow link
      </button>
    </div>
  ),
}))
vi.mock("@/components/ai-elements/code-block", () => ({
  CodeBlockContent: ({
    code,
    language,
  }: {
    code: string
    language: string
  }) => (
    <div data-testid="source" data-language={language}>
      <code>{code}</code>
    </div>
  ),
}))
vi.mock("@/components/files/image-preview", () => ({
  ImagePreview: () => <div data-testid="image" />,
}))
vi.mock("@/components/files/office-preview", () => ({
  OfficePreview: ({ relPath }: { relPath: string | null }) => (
    <div data-testid="office" data-rel={relPath ?? ""} />
  ),
}))
vi.mock("@/components/files/html-preview", () => ({
  HtmlPreview: () => <div data-testid="html" />,
}))
vi.mock("@/components/diff/unified-diff-preview", () => ({
  UnifiedDiffPreview: ({ diffText }: { diffText: string }) => (
    <div data-testid="diff">{diffText}</div>
  ),
}))

function tab(overrides: Partial<FileWorkspaceTab>): FileWorkspaceTab {
  return {
    id: TAB_ID,
    kind: "file",
    folderId: null,
    title: "plan.md",
    description: ABS_PATH,
    path: ABS_PATH,
    language: "markdown",
    content: "# Plan",
    loading: false,
    ...overrides,
  } as FileWorkspaceTab
}

type Request = {
  path: string
  line: number | null
  folderId?: number
  diff?: { content: string; groupLabel: string }
}

/** Swap the open tab set and let the panel observe it. */
function setTabs(next: FileWorkspaceTab[]) {
  state.fileTabs = next
  for (const listener of [...state.listeners]) listener()
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function open(request: Request) {
  render(<FileViewerDrawer request={request} open onOpenChange={vi.fn()} />)
  // `openFilePreview` resolves the absolute path the tab is keyed by; the body
  // cannot find its tab until that settles.
  await settle()
}

describe("FileViewerDrawer", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.fileTabs = []
    state.previewFileTabIds = new Set()
    mockOpenFilePreview.mockResolvedValue(ABS_PATH)
  })

  it("opens through the shared file tab and renders the one it created", async () => {
    state.fileTabs = [tab({})]
    state.previewFileTabIds = new Set([TAB_ID])

    await open({ path: "docs/plan.md", line: 12, folderId: 1 })

    // The request is forwarded verbatim — the drawer does no path resolution
    // of its own, so the tab it shows is byte-identical to the column's.
    expect(mockOpenFilePreview).toHaveBeenCalledWith("docs/plan.md", {
      line: 12,
      folderId: 1,
    })
    const markdown = screen.getByTestId("markdown")
    expect(markdown).toHaveTextContent("# Plan")
    expect(markdown).toHaveAttribute("data-file-dir", "/repo/docs")
    // Root-relative refs resolve against the OWNING registered folder, not the
    // document's directory — same rule the file column applies.
    expect(markdown).toHaveAttribute("data-preview-root", "/repo")
  })

  it("shows source when the tab is not in preview mode", async () => {
    state.fileTabs = [tab({ language: "typescript", content: "const a = 1" })]

    await open({ path: ABS_PATH, line: null })

    expect(screen.queryByTestId("markdown")).not.toBeInTheDocument()
    expect(screen.getByTestId("source")).toHaveAttribute(
      "data-language",
      "typescript"
    )
  })

  it("translates monaco language ids shiki does not know", async () => {
    state.fileTabs = [tab({ language: "shell", content: "echo hi" })]

    await open({ path: ABS_PATH, line: null })

    expect(screen.getByTestId("source")).toHaveAttribute(
      "data-language",
      "bash"
    )
  })

  it("routes image and office tabs to their own renderers", async () => {
    state.fileTabs = [tab({ language: "image" })]
    await open({ path: ABS_PATH, line: null })
    expect(screen.getByTestId("image")).toBeInTheDocument()

    state.fileTabs = [tab({ language: "office" })]
    await open({ path: ABS_PATH, line: null })
    expect(screen.getByTestId("office")).toHaveAttribute("data-rel", "plan.md")
  })

  it("waits for content rather than showing an empty document", async () => {
    state.fileTabs = [tab({ loading: true, content: "" })]
    state.previewFileTabIds = new Set([TAB_ID])

    await open({ path: ABS_PATH, line: null })

    expect(screen.queryByTestId("markdown")).not.toBeInTheDocument()
    expect(screen.getByText("loading")).toBeInTheDocument()
  })

  it("says so when the path cannot be resolved to a file at all", async () => {
    mockOpenFilePreview.mockResolvedValue(null)

    await open({ path: "notes.md", line: null })

    expect(screen.getByText("cannotResolve")).toBeInTheDocument()
  })

  it("hands the very same tab over to the file column", async () => {
    state.fileTabs = [tab({})]

    await open({ path: "docs/plan.md", line: null, folderId: 1 })
    act(() => {
      screen.getByTitle("openInWorkspace").click()
    })

    // Leaving the full-page route is half the action: activating a file tab
    // while the board still covers the workspace would put the file back
    // somewhere the user cannot see.
    expect(mockOpenConversations).toHaveBeenCalledTimes(1)
    expect(mockSwitchFileTab).toHaveBeenCalledWith(TAB_ID)
  })

  it("shares the preview/source toggle with the file column", async () => {
    state.fileTabs = [tab({})]
    state.previewFileTabIds = new Set([TAB_ID])

    await open({ path: "docs/plan.md", line: null })
    act(() => {
      screen.getByTitle("source").click()
    })

    // The column's own toggle, not a private copy — flipping it here flips it
    // there too, so the two surfaces never disagree about one file.
    expect(mockToggleFileTabPreview).toHaveBeenCalledWith(TAB_ID)
  })

  it("renders a reply's diff from the patch it was handed, reading nothing", async () => {
    // The "view diff" action carries its own content, so this branch mirrors no
    // file tab at all — it must not go looking for one.
    await open({
      path: "src/a.ts",
      line: null,
      diff: { content: "@@ -1 +1 @@", groupLabel: "turn-1" },
    })

    expect(mockOpenFilePreview).not.toHaveBeenCalled()
    expect(screen.getByTestId("diff")).toHaveTextContent("@@ -1 +1 @@")
    expect(screen.queryByText("loading")).not.toBeInTheDocument()
  })

  it("mints the diff tab when handing a diff over to the file column", async () => {
    await open({
      path: "src/a.ts",
      line: null,
      folderId: 2,
      diff: { content: "@@ -1 +1 @@", groupLabel: "turn-1" },
    })
    act(() => {
      screen.getByTitle("openInWorkspace").click()
    })

    // There is no tab to activate — the same call the reply's action would have
    // made on the conversations route creates it.
    expect(mockSwitchFileTab).not.toHaveBeenCalled()
    expect(mockOpenConversations).toHaveBeenCalledTimes(1)
    expect(mockOpenSessionFileDiff).toHaveBeenCalledWith(
      "src/a.ts",
      "@@ -1 +1 @@",
      "turn-1",
      { folderId: 2 }
    )
  })

  it("reopens the tab if it is closed out from under the panel", async () => {
    // Opening the panel activates the files pane, which is what arms ⌘W /
    // "close all file tabs" — so the user can close this very tab without ever
    // seeing the column. Sitting on a spinner forever is the failure mode.
    state.fileTabs = [tab({})]
    state.previewFileTabIds = new Set([TAB_ID])
    await open({ path: "docs/plan.md", line: null })
    expect(screen.getByTestId("markdown")).toBeInTheDocument()
    expect(mockOpenFilePreview).toHaveBeenCalledTimes(1)

    // ⌘W closes it.
    await act(async () => {
      setTabs([])
    })
    // The panel asks for it back instead of settling into a spinner.
    expect(mockOpenFilePreview).toHaveBeenCalledTimes(2)

    // Stand in for what that second call does in the real store.
    await act(async () => {
      setTabs([tab({})])
    })
    expect(screen.getByTestId("markdown")).toBeInTheDocument()
    // And it stops there — no reopen loop once the tab is back.
    await settle()
    expect(mockOpenFilePreview).toHaveBeenCalledTimes(2)
  })

  it.each([true, false])(
    "renders a save-failed tab's own buffer rather than an error notice (dirty=%s)",
    async (isDirty) => {
      // A load failure and a save failure share `saveState: "error"` and
      // nothing on the tab tells them apart — `isDirty` is not a marker
      // either, because reverting the buffer while a doomed save is in flight
      // leaves it clean. Guessing wrong would print the whole document as an
      // error message, so the panel renders what the tab holds either way.
      state.fileTabs = [
        tab({
          isDirty,
          saveState: "error",
          saveError: "EACCES",
          content: "# Plan\n\nunsaved edits",
        }),
      ]
      state.previewFileTabIds = new Set([TAB_ID])

      await open({ path: ABS_PATH, line: null })

      expect(screen.getByTestId("markdown")).toHaveTextContent("unsaved edits")
    }
  )

  it("still surfaces a failed LOAD, through the document body", async () => {
    // `rejectTab` writes the localized sentence into `content`; the file column
    // shows it in the document too, so the panel does not second-guess it.
    state.fileTabs = [
      tab({
        isDirty: false,
        saveState: "error",
        saveError: "ENOENT",
        content: "unable to load: ENOENT",
      }),
    ]
    state.previewFileTabIds = new Set([TAB_ID])

    await open({ path: ABS_PATH, line: null })

    expect(screen.getByTestId("markdown")).toHaveTextContent(
      "unable to load: ENOENT"
    )
  })

  it("tells a file apart from a diff OF THAT FILE when swapping requests", async () => {
    // Both sit in one action row, so they arrive with the same path, no line
    // and no folder. Keying on those alone left the panel showing whichever
    // was opened first.
    const request = {
      path: "docs/plan.md",
      line: null,
      diff: { content: "@@ -1 +1 @@", groupLabel: "turn-1" },
    }
    const { rerender } = render(
      <FileViewerDrawer request={request} open onOpenChange={vi.fn()} />
    )
    await settle()
    expect(screen.getByTestId("diff")).toBeInTheDocument()

    state.fileTabs = [tab({})]
    state.previewFileTabIds = new Set([TAB_ID])
    rerender(
      <FileViewerDrawer
        request={{ path: "docs/plan.md", line: null }}
        open
        onOpenChange={vi.fn()}
      />
    )
    await settle()

    expect(screen.queryByTestId("diff")).not.toBeInTheDocument()
    expect(screen.getByTestId("markdown")).toHaveTextContent("# Plan")
  })

  it("refuses to render a file too big for an unvirtualized view", async () => {
    // `CodeBlockContent` builds one DOM node per line and hands the whole text
    // to shiki. Monaco (the file column) virtualizes; this panel does not, so
    // it declines instead of locking the page up.
    state.fileTabs = [
      tab({ language: "typescript", content: "x\n".repeat(20_000) }),
    ]

    await open({ path: ABS_PATH, line: null })

    expect(screen.queryByTestId("source")).not.toBeInTheDocument()
    expect(screen.getByText("tooLargeToPreview")).toBeInTheDocument()
  })

  it("follows a markdown link inside the panel, and back out again", async () => {
    // Agent-written docs link to each other. Following one into the covered
    // file column would drop the reader back where they could not see, so the
    // panel navigates itself — which is only sane with a way back.
    const nextTab = tab({
      id: buildFileTabId({ kind: "file", path: "/repo/docs/spec.md" }),
      title: "spec.md",
      description: "/repo/docs/spec.md",
      path: "/repo/docs/spec.md",
      content: "# Spec",
    })
    state.fileTabs = [tab({}), nextTab]
    state.previewFileTabIds = new Set([TAB_ID, nextTab.id])
    mockOpenFilePreview.mockImplementation(async (raw: string) =>
      raw.startsWith("/") ? raw : ABS_PATH
    )

    await open({ path: "docs/plan.md", line: null })
    expect(screen.queryByTitle("back")).not.toBeInTheDocument()
    expect(screen.getByTestId("markdown")).toHaveTextContent("# Plan")

    await act(async () => {
      screen.getByText("follow link").click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.getByTestId("markdown")).toHaveTextContent("# Spec")
    expect(screen.getByTitle("back")).toBeInTheDocument()

    await act(async () => {
      screen.getByTitle("back").click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.getByTestId("markdown")).toHaveTextContent("# Plan")
    expect(screen.queryByTitle("back")).not.toBeInTheDocument()
  })
})
