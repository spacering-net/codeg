import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { ReplyArtifacts } from "./reply-artifacts"
import type { FileChangeStat } from "@/lib/session-files"
import type { MessageTurn } from "@/lib/types"

// Stable `t` (per next-intl mock guidance) returns the key verbatim — enough to
// address every label here (section headers, the per-file `viewDiff` /
// `revealInFolder` actions, the `noDiffDataAvailable` fallback).
const { stableT, mockOpenDiff, mockOpenFilePreview, mockReveal, mockExtract } =
  vi.hoisted(() => ({
    stableT: (key: string) => key,
    mockOpenDiff: vi.fn(),
    mockOpenFilePreview: vi.fn(),
    mockReveal: vi.fn(),
    mockExtract: vi.fn(),
  }))

vi.mock("next-intl", () => ({ useTranslations: () => stableT }))
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({
    openFilePreview: mockOpenFilePreview,
    openSessionFileDiff: mockOpenDiff,
  }),
}))
vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: { path: "/repo" } }),
}))
vi.mock("@/lib/platform", () => ({
  isLocalDesktop: () => true,
  revealItemInDir: mockReveal,
}))
// Drive the card's file list directly — the extractor itself is covered by
// session-files' own tests; here we only wire the parsed shape into the UI.
vi.mock("@/lib/session-files", () => ({
  extractReplyFileChanges: (turns: unknown) => mockExtract(turns),
}))

const MODIFIED_DIFF =
  "diff --git a/src/a.ts b/src/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new"
const DELETION_DIFF = "*** Delete File: src/gone.ts\n-a\n-b"

// Only `sourceTurns[0].id` is read (it keys the diff tab); the file list comes
// from the mocked extractor, so a bare id is all this fixture needs.
const sourceTurns = [{ id: "reply-turn-1" }] as unknown as MessageTurn[]

function renderCard(files: FileChangeStat[]) {
  mockExtract.mockReturnValue(files)
  return render(<ReplyArtifacts sourceTurns={sourceTurns} isResponseComplete />)
}

// The "Files changed" section is collapsed by default — expand it so the
// per-file action buttons mount.
function expandChanged() {
  fireEvent.click(screen.getByText("title"))
}

describe("ReplyArtifacts — view diff action", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("opens the file's diff in the editor, keyed by the reply turn", () => {
    renderCard([
      {
        id: "f1",
        path: "src/a.ts",
        additions: 1,
        deletions: 1,
        diff: MODIFIED_DIFF,
      },
    ])
    expandChanged()

    fireEvent.click(screen.getByRole("button", { name: "viewDiff" }))

    // The 4th argument is the opener's folder option, forwarded verbatim —
    // `undefined` means "resolve against the active folder", exactly what the
    // 3-argument call meant before this action started routing through
    // `useOpenFileTarget`.
    expect(mockOpenDiff).toHaveBeenCalledWith(
      "src/a.ts",
      MODIFIED_DIFF,
      "reply-turn-1",
      { folderId: undefined }
    )
  })

  it("falls back to the placeholder when the file has no diff data", () => {
    renderCard([
      { id: "f2", path: "src/b.ts", additions: 0, deletions: 0, diff: null },
    ])
    expandChanged()

    fireEvent.click(screen.getByRole("button", { name: "viewDiff" }))

    expect(mockOpenDiff).toHaveBeenCalledWith(
      "src/b.ts",
      "noDiffDataAvailable",
      "reply-turn-1",
      { folderId: undefined }
    )
  })

  it("places View Diff to the left of Show-in-file-manager", () => {
    renderCard([
      {
        id: "f1",
        path: "src/a.ts",
        additions: 1,
        deletions: 1,
        diff: MODIFIED_DIFF,
      },
    ])
    expandChanged()

    const viewDiffBtn = screen.getByRole("button", { name: "viewDiff" })
    const revealBtn = screen.getByRole("button", { name: "revealInFolder" })
    // View Diff precedes the reveal button in document order.
    expect(
      viewDiffBtn.compareDocumentPosition(revealBtn) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it("does not offer View Diff for a removed file (nothing to open)", () => {
    renderCard([
      {
        id: "f3",
        path: "src/gone.ts",
        additions: 0,
        deletions: 2,
        diff: DELETION_DIFF,
      },
    ])
    expandChanged()

    expect(
      screen.queryByRole("button", { name: "viewDiff" })
    ).not.toBeInTheDocument()
    // The removed file still renders its static destructive badge.
    expect(screen.getByText("remove")).toBeInTheDocument()
  })
})
