import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  type ReactNode,
  type Ref,
} from "react"

// The list sizes its scroll window (and the action bubble) in rem, so it reads
// the live zoom level — which throws outside an AppearanceProvider. Pin it at
// 100%. Spread the real module so the other appearance hooks keep their real
// behaviour instead of silently resolving to `undefined`.
vi.mock("@/hooks/use-appearance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-appearance")>()),
  useZoomLevel: () => ({ zoomLevel: 100, setZoomLevel: () => {} }),
}))

// virtua renders ZERO rows under jsdom (no layout), so render every child
// directly and forward a no-op scrollToIndex handle for keyboard navigation.
vi.mock("virtua", () => ({
  Virtualizer: forwardRef(function VirtualizerMock(
    props: { children?: ReactNode },
    ref: Ref<{ scrollToIndex: (i: number) => void }>
  ) {
    useImperativeHandle(ref, () => ({ scrollToIndex: vi.fn() }))
    return <>{props.children}</>
  }),
}))

// The list mounts virtua only once the OverlayScrollbars viewport exists, which
// it learns via `onViewportRef`. jsdom never lays out / initializes OS, so drive
// that callback with a real element so the rows render.
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

import { BranchSelectorList, splitBranchLabel } from "./branch-selector-list"
import enMessages from "@/i18n/messages/en.json"
import {
  buildBranchTree,
  localBranchItems,
  worktreeBranchNodes,
} from "@/lib/branch-tree"

const LOCAL = ["main", "feature/login", "task/132", "loop/x"]
const WORKTREES = ["task/132", "loop/x"]

function renderList(
  overrides: Partial<Parameters<typeof BranchSelectorList>[0]> = {}
) {
  const onLeafAction = vi.fn()
  const onRunOperation = vi.fn()
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BranchSelectorList
        operations={[{ id: "pull", label: "Pull code" }]}
        worktreeNodes={worktreeBranchNodes(WORKTREES, null)}
        localNodes={buildBranchTree(localBranchItems(LOCAL), "local")}
        remoteSections={[]}
        localCount={LOCAL.length}
        remoteCount={0}
        branch="main"
        worktreeBranchSet={new Set(WORKTREES)}
        mainWorktreeBranch={null}
        branchLoading={false}
        loading={false}
        onRunOperation={onRunOperation}
        onLeafAction={onLeafAction}
        {...overrides}
      />
    </NextIntlClientProvider>
  )
  return { onLeafAction, onRunOperation }
}

/** Row labels in render order, so section ordering is assertable. */
function optionLabels(): string[] {
  return screen
    .getAllByRole("option")
    .map((el) => el.textContent?.trim() ?? "")
    .filter(Boolean)
}

describe("BranchSelectorList — worktree section", () => {
  afterEach(() => cleanup())

  it("lists the other worktrees above the local branches", () => {
    renderList()
    const labels = optionLabels()
    expect(labels).toContain("Worktree branches (2)")
    expect(labels).toContain("Local branches (4)")
    expect(labels.indexOf("Worktree branches (2)")).toBeLessThan(
      labels.indexOf("Local branches (4)")
    )
    // These two share no prefix, so each collapses to one whole-ref row.
    expect(
      labels.slice(labels.indexOf("Worktree branches (2)") + 1, 3 + 1)
    ).toEqual(["loop/x", "task/132"])
  })

  it("folds a shared prefix into a collapsed group, like the local tree", () => {
    const shared = ["task/131", "task/132"]
    renderList({
      worktreeNodes: worktreeBranchNodes(shared, null),
      worktreeBranchSet: new Set(shared),
    })
    // The section header stays open and still counts both branches; the group
    // under it arrives folded, so neither branch has a row yet.
    expect(optionLabels().slice(1, 3)).toEqual([
      "Worktree branches (2)",
      "task/2",
    ])
    expect(optionLabels()).not.toContain("131")
  })

  it("expands a worktree prefix group on click", async () => {
    const user = userEvent.setup()
    const shared = ["task/131", "task/132"]
    renderList({
      worktreeNodes: worktreeBranchNodes(shared, null),
      worktreeBranchSet: new Set(shared),
    })
    const groupRow = screen
      .getAllByRole("option")
      .find((el) => el.textContent?.trim() === "task/2")
    await user.click(groupRow as HTMLElement)
    expect(optionLabels().slice(1, 5)).toEqual([
      "Worktree branches (2)",
      "task/2",
      "131",
      "132",
    ])
  })

  it("holds its place with an empty row for a repo with no other worktree", () => {
    renderList({ worktreeNodes: [], worktreeBranchSet: new Set() })
    expect(optionLabels()).toContain("Worktree branches (0)")
    expect(screen.getByText("No worktree branches")).toBeInTheDocument()
  })

  it("offers switch and the worktree removals on a worktree row", async () => {
    const user = userEvent.setup()
    const { onLeafAction } = renderList()
    // The first "task/132" row is the worktree section's copy.
    await user.click(screen.getAllByRole("option", { name: "task/132" })[0])
    const bubble = screen.getByRole("menu", { name: "task/132" })
    expect(
      within(bubble)
        .getAllByRole("menuitem")
        .map((el) => el.textContent?.trim())
    ).toEqual([
      "Switch to this branch",
      "Merge task/132 into main",
      "Rebase main onto task/132",
      "Pull code",
      "Push",
      // Never plain "Delete branch": git refuses while a worktree holds the ref.
      "Delete worktree",
      "Delete worktree and branch",
    ])
    await user.click(within(bubble).getByRole("menuitem", { name: /Switch/ }))
    expect(onLeafAction).toHaveBeenCalledWith("switch", "task/132", false)
  })

  it("keeps searching across both sections", async () => {
    const user = userEvent.setup()
    renderList()
    await user.type(screen.getByRole("combobox"), "task")
    const labels = optionLabels()
    expect(labels).toEqual([
      "Worktree branches (1)",
      "task/132",
      "Local branches (1)",
      "task/132",
    ])
  })

  it("collapses the section without touching the local tree", async () => {
    const user = userEvent.setup()
    renderList()
    await user.click(
      screen.getByRole("option", { name: "Worktree branches (2)" })
    )
    const labels = optionLabels()
    expect(labels).toEqual([
      "Pull code",
      "Worktree branches (2)",
      "Local branches (4)",
      // The local tree still lists both worktree branches.
      "feature/login",
      "loop/x",
      // The checked-out branch and its adjacent "Current" badge, unspaced.
      "mainCurrent",
      "task/132",
      "Remote branches (0)",
    ])
  })
})

describe("BranchSelectorList — long branch names in the action bubble", () => {
  afterEach(() => cleanup())

  // No "/" so it stays a top-level leaf instead of folding into a collapsed group.
  const LONG = "browser-remote-egress-with-a-very-long-branch-name"

  it("truncates each branch name on its own and keeps the full label as a tooltip", async () => {
    const user = userEvent.setup()
    renderList({
      localNodes: buildBranchTree(localBranchItems(["main", LONG]), "local"),
      worktreeNodes: [],
      worktreeBranchSet: new Set(),
      localCount: 2,
    })
    await user.click(screen.getByRole("option", { name: LONG }))
    const bubble = screen.getByRole("menu", { name: LONG })
    // Sizes to its content (capped), instead of a fixed narrow width.
    expect(bubble.className).toContain("w-max")
    expect(bubble.style.maxWidth).toBe("416px")

    const merge = within(bubble).getByRole("menuitem", { name: /^Merge/ })
    expect(merge).toHaveAttribute("title", `Merge ${LONG} into main`)
    const parts = Array.from(merge.querySelectorAll("span > span")).map(
      (el) => [el.textContent, el.className]
    )
    expect(parts).toEqual([
      ["Merge ", "shrink-0 whitespace-pre"],
      [LONG, "min-w-0 truncate"],
      [" into ", "shrink-0 whitespace-pre"],
      ["main", "min-w-0 truncate"],
    ])

    // Plain single-string actions keep the old single truncated span.
    const sw = within(bubble).getByRole("menuitem", { name: /Switch/ })
    expect(sw).not.toHaveAttribute("title")
  })
})

describe("splitBranchLabel", () => {
  it("follows the translation's own word order", () => {
    // ja puts the target first for rebase: "{currentBranch} を {branchName} にリベース"
    expect(
      splitBranchLabel("\u00001\u0000 を \u00000\u0000 にリベース", [
        "feat/x",
        "main",
      ])
    ).toEqual([
      { text: "main", isBranch: true },
      { text: " を ", isBranch: false },
      { text: "feat/x", isBranch: true },
      { text: " にリベース", isBranch: false },
    ])
  })
})
