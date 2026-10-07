import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  UnifiedDiffPreview,
  toSplitRows,
  type ParsedDiffRow,
} from "./unified-diff-preview"
import enMessages from "@/i18n/messages/en.json"

// The component reads the active folder only to strip a path prefix from the
// file header; a null folder is enough for these tests.
vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: null }),
}))

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {children}
    </NextIntlClientProvider>
  )
}

// `wrapper` so `rerender` re-applies the intl provider automatically.
function renderWithIntl(ui: React.ReactElement) {
  return render(ui, { wrapper: Wrapper })
}

/** A single-file "add" diff with `lineCount` added rows. */
function newFileDiff(lineCount: number): string {
  const header = `diff --git a/big.txt b/big.txt\n--- /dev/null\n+++ b/big.txt\n@@ -0,0 +1,${lineCount} @@\n`
  const body = Array.from(
    { length: lineCount },
    (_, i) => `+line ${i + 1}`
  ).join("\n")
  return `${header}${body}\n`
}

describe("UnifiedDiffPreview", () => {
  it("renders every row for a small diff and shows no reveal control", () => {
    renderWithIntl(<UnifiedDiffPreview diffText={newFileDiff(3)} />)

    expect(screen.getByText("line 1")).toBeInTheDocument()
    expect(screen.getByText("line 3")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /more lines/ })
    ).not.toBeInTheDocument()
  })

  it("caps a large diff at 500 rows and offers to reveal the rest", () => {
    renderWithIntl(<UnifiedDiffPreview diffText={newFileDiff(600)} />)

    // The first 500 rows render; rows past the cap do not.
    expect(screen.getByText("line 500")).toBeInTheDocument()
    expect(screen.queryByText("line 501")).not.toBeInTheDocument()
    expect(screen.queryByText("line 600")).not.toBeInTheDocument()

    // The reveal control reports exactly the hidden count (600 - 500).
    expect(
      screen.getByRole("button", { name: "Show 100 more lines" })
    ).toBeInTheDocument()
  })

  it("reveals all rows and drops the control once expanded", () => {
    renderWithIntl(<UnifiedDiffPreview diffText={newFileDiff(600)} />)

    fireEvent.click(screen.getByRole("button", { name: "Show 100 more lines" }))

    expect(screen.getByText("line 600")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /more lines/ })
    ).not.toBeInTheDocument()
  })

  it("re-caps when the same preview receives a different large diff", () => {
    const { rerender } = renderWithIntl(
      <UnifiedDiffPreview diffText={newFileDiff(600)} />
    )
    // Fully expand the first diff.
    fireEvent.click(screen.getByRole("button", { name: "Show 100 more lines" }))
    expect(screen.getByText("line 600")).toBeInTheDocument()

    // A different, larger diff arrives at the same file position. Sections are
    // keyed positionally, so the instance is reused — the reveal must reset so
    // the new diff is capped again rather than rendered in full.
    rerender(<UnifiedDiffPreview diffText={newFileDiff(700)} />)

    expect(
      screen.getByRole("button", { name: "Show 200 more lines" })
    ).toBeInTheDocument()
    expect(screen.getByText("line 500")).toBeInTheDocument()
    expect(screen.queryByText("line 700")).not.toBeInTheDocument()
  })
})

describe("UnifiedDiffPreview — binary files", () => {
  it("keeps a binary change visible instead of dropping the file", () => {
    // Hunkless by nature: before this was handled, the file was filtered out
    // and an image change vanished from the diff entirely.
    renderWithIntl(
      <UnifiedDiffPreview
        diffText={[
          "diff --git a/logo.png b/logo.png",
          "index 1111111..2222222 100644",
          "Binary files a/logo.png and b/logo.png differ",
          "",
        ].join("\n")}
      />
    )

    expect(screen.getByText("logo.png")).toBeInTheDocument()
    expect(
      screen.getByText(enMessages.Folder.diffPreview.binaryFile)
    ).toBeInTheDocument()
    expect(screen.getByText("Modified")).toBeInTheDocument()
  })

  it("reads add/delete off the extended header a binary file does have", () => {
    renderWithIntl(
      <UnifiedDiffPreview
        diffText={[
          "diff --git a/icon.png b/icon.png",
          "new file mode 100644",
          "index 0000000..3333333",
          "Binary files /dev/null and b/icon.png differ",
          "",
        ].join("\n")}
      />
    )

    // No `--- /dev/null` line exists here for the mode to be inferred from.
    expect(screen.getByText("Added")).toBeInTheDocument()
  })

  it("does not paint base85 payload lines as diff rows", () => {
    // `git diff --binary` emits base85, whose alphabet includes "+" and "-".
    renderWithIntl(
      <UnifiedDiffPreview
        diffText={[
          "diff --git a/logo.png b/logo.png",
          "index 1111111..2222222 100644",
          "GIT binary patch",
          "literal 12",
          "+c$@(NfB*mh",
          "-zcmeAS@N?",
          "",
        ].join("\n")}
      />
    )

    expect(screen.queryByText("c$@(NfB*mh")).not.toBeInTheDocument()
    expect(screen.queryByText("zcmeAS@N?")).not.toBeInTheDocument()
    expect(
      screen.getByText(enMessages.Folder.diffPreview.binaryFile)
    ).toBeInTheDocument()
  })

  it("keeps a spaced binary path intact, having no --- line to recover from", () => {
    // `a/<p1> b/<p2>` is ambiguous when the path has a space, and a binary file
    // carries no `--- `/`+++ ` lines to correct a bad guess.
    renderWithIntl(
      <UnifiedDiffPreview
        diffText={[
          "diff --git a/img/my logo.png b/img/my logo.png",
          "index 1111111..2222222 100644",
          "Binary files a/img/my logo.png and b/img/my logo.png differ",
          "",
        ].join("\n")}
      />
    )

    expect(screen.getByText("img/my logo.png")).toBeInTheDocument()
  })

  it("names a binary rename off its rename headers", () => {
    renderWithIntl(
      <UnifiedDiffPreview
        diffText={[
          "diff --git a/old icon.png b/new icon.png",
          "similarity index 80%",
          "rename from old icon.png",
          "rename to new icon.png",
          "index 1111111..2222222 100644",
          "Binary files a/old icon.png and b/new icon.png differ",
          "",
        ].join("\n")}
      />
    )

    expect(screen.getByText("new icon.png")).toBeInTheDocument()
    expect(screen.getByText("Renamed")).toBeInTheDocument()
  })

  it("still line-diffs an svg, which git treats as text", () => {
    renderWithIntl(
      <UnifiedDiffPreview
        diffText={[
          "diff --git a/icon.svg b/icon.svg",
          "--- a/icon.svg",
          "+++ b/icon.svg",
          "@@ -1,1 +1,1 @@",
          '-<svg width="16"/>',
          '+<svg width="32"/>',
          "",
        ].join("\n")}
      />
    )

    expect(screen.getByText('<svg width="32"/>')).toBeInTheDocument()
    expect(
      screen.queryByText(enMessages.Folder.diffPreview.binaryFile)
    ).not.toBeInTheDocument()
  })
})

describe("UnifiedDiffPreview — sticky line numbers", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  // jsdom does no layout, so these pin the declarations that ARE the
  // behaviour (both verified in Chromium): the rail holds at x=0 of its
  // scrollport while the code slides under it, and its OPAQUE base is what
  // stops the code from showing through the digits — every row tint is
  // translucent, so a rail carrying only the tint would be see-through.

  it("pins the scroll bodies to LTR in both views", () => {
    // The app puts the document in `dir="rtl"` for Arabic, and a diff is
    // left-to-right whatever the UI language. Under RTL the panes would swap,
    // react-resizable-panels would invert the drag, each scrollport would
    // report `scrollLeft` as 0 at its right edge counting into negatives, and
    // this rail would stick to the edge the numbers are no longer on. The
    // direction has to sit on the scroll container itself — that is what
    // decides both the layout and the sign of `scrollLeft`.
    const { container } = renderWithIntl(
      <UnifiedDiffPreview diffText={modifiedDiff()} />
    )
    // Scoped to the file section: the preview's own outer frame is a
    // ScrollArea too, and it holds the header, which stays with the UI.
    expect(
      container.querySelector("section [data-overlayscrollbars-initialize]")
    ).toHaveAttribute("dir", "ltr")

    fireEvent.click(
      screen.getByRole("button", { name: "Switch to side-by-side view" })
    )

    const group = container.querySelector("[data-panel-group]")
    expect(group).toHaveAttribute("dir", "ltr")
    const panes = container.querySelectorAll(
      "[data-panel] [data-overlayscrollbars-initialize]"
    )
    expect(panes).toHaveLength(2)
  })

  it("carries the numbers and the sign on an opaque rail, inline", () => {
    const { container } = renderWithIntl(
      <UnifiedDiffPreview diffText={modifiedDiff()} />
    )

    const rails = container.querySelectorAll(".sticky.left-0")
    // One per row: context, two deletions, one addition, context.
    expect(rails).toHaveLength(5)
    expect(rails[0]).toHaveClass("bg-background")
    // Old number, new number, and the +/- marker travel together; the code
    // does not, which is the whole point.
    expect(rails[0]?.textContent).toBe("11")
    expect(rails[1]?.textContent).toBe("2-")
    expect(rails[0]?.textContent).not.toContain("keep one")
  })

  it("carries each pane's own numbers on its own rail, side by side", () => {
    localStorage.setItem("workspace:diff-view-mode", "split")
    const { container } = renderWithIntl(
      <UnifiedDiffPreview diffText={modifiedDiff()} />
    )

    const rails = container.querySelectorAll(".sticky.left-0")
    // Four paired rows, two sides.
    expect(rails).toHaveLength(8)
    for (const rail of rails) expect(rail).toHaveClass("bg-background")
    expect(rails[0]?.textContent).toBe("1")
    expect(rails[0]?.textContent).not.toContain("keep one")
  })
})

/** A single-file modified diff: one context row, two deletions, one addition,
 *  one more context row — exercises the split pairing with unequal runs. */
function modifiedDiff(): string {
  return [
    "diff --git a/app.ts b/app.ts",
    "--- a/app.ts",
    "+++ b/app.ts",
    "@@ -1,5 1,4 @@",
    " keep one",
    "-old line A",
    "-old line B",
    "+new line A",
    " keep two",
  ].join("\n")
}

/** A second modified file, for asserting that two previews on one screen share
 *  the view-mode preference. */
function otherModifiedDiff(): string {
  return [
    "diff --git a/other.ts b/other.ts",
    "--- a/other.ts",
    "+++ b/other.ts",
    "@@ -1,2 +1,2 @@",
    " shared context",
    "-was here",
    "+is here",
  ].join("\n")
}

/** A two-hunk diff, so the second hunk's `@@` marker has to be drawn. */
function twoHunkDiff(): string {
  return [
    "diff --git a/two.ts b/two.ts",
    "--- a/two.ts",
    "+++ b/two.ts",
    "@@ -1,3 +1,3 @@",
    " alpha",
    "-old top",
    "+new top",
    "@@ -10,3 +12,3 @@",
    " beta",
    "-old bottom",
    "+new bottom",
  ].join("\n")
}

/** The unified rows `parseUnifiedDiff` derives from `modifiedDiff`, so the
 *  pairing unit tests feed the exact shape production renders. */
function modifiedRows(): ParsedDiffRow[] {
  return [
    { type: "context", text: "keep one", sign: " ", oldLine: 1, newLine: 1 },
    {
      type: "deleted",
      text: "old line A",
      sign: "-",
      oldLine: 2,
      newLine: null,
    },
    {
      type: "deleted",
      text: "old line B",
      sign: "-",
      oldLine: 3,
      newLine: null,
    },
    { type: "added", text: "new line A", sign: "+", oldLine: null, newLine: 2 },
    { type: "context", text: "keep two", sign: " ", oldLine: 4, newLine: 3 },
  ]
}

describe("UnifiedDiffPreview — side-by-side view", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("renders unified signs by default and keeps the split mode opt-in", () => {
    renderWithIntl(<UnifiedDiffPreview diffText={modifiedDiff()} />)

    expect(screen.getAllByText("+")).toHaveLength(1)
    expect(screen.getAllByText("-")).toHaveLength(2)
  })

  it("reads a persisted split preference before the first render", () => {
    localStorage.setItem("workspace:diff-view-mode", "split")
    renderWithIntl(<UnifiedDiffPreview diffText={modifiedDiff()} />)

    expect(screen.queryByText("+")).not.toBeInTheDocument()
    // Context rows now render once per side.
    expect(screen.getAllByText("keep one")).toHaveLength(2)
  })

  it("toggles to split, renders both sides, and persists the choice", () => {
    renderWithIntl(<UnifiedDiffPreview diffText={modifiedDiff()} />)

    fireEvent.click(
      screen.getByRole("button", { name: "Switch to side-by-side view" })
    )

    // No unified sign column anymore; both sides' texts are on screen.
    expect(screen.queryByText("+")).not.toBeInTheDocument()
    expect(screen.getAllByText("keep one")).toHaveLength(2)
    expect(screen.getByText("old line A")).toBeInTheDocument()
    expect(screen.getByText("new line A")).toBeInTheDocument()
    expect(localStorage.getItem("workspace:diff-view-mode")).toBe("split")
  })

  it("toggles back to unified and persists it", () => {
    localStorage.setItem("workspace:diff-view-mode", "split")
    renderWithIntl(<UnifiedDiffPreview diffText={modifiedDiff()} />)

    fireEvent.click(
      screen.getByRole("button", { name: "Switch to inline view" })
    )

    expect(screen.getByText("+")).toBeInTheDocument()
    expect(localStorage.getItem("workspace:diff-view-mode")).toBe("unified")
  })

  it("flips every preview mounted alongside it, not just the clicked one", () => {
    // A transcript renders one preview per Edit/Write tool call, and a
    // permission dialog stacks another on top. The view mode is a single
    // preference, so toggling one must not leave its siblings inline until
    // they happen to remount.
    renderWithIntl(
      <>
        <UnifiedDiffPreview diffText={modifiedDiff()} />
        <UnifiedDiffPreview diffText={otherModifiedDiff()} />
      </>
    )

    fireEvent.click(
      screen.getAllByRole("button", { name: "Switch to side-by-side view" })[0]!
    )

    // Context rows render once per side in split mode — both previews switched.
    expect(screen.getAllByText("keep one")).toHaveLength(2)
    expect(screen.getAllByText("shared context")).toHaveLength(2)
  })

  it("gives each side its own pane with a resize handle between them", () => {
    // The two sides are separate scroll containers so each can scroll to its
    // own longest line (`use-synced-scroll` puts them back in step). jsdom
    // does no layout, so this pins the structure that makes that possible:
    // two panes, a draggable separator, and a `w-max` content box per side so
    // the pane has something wider than itself to scroll.
    localStorage.setItem("workspace:diff-view-mode", "split")
    const { container } = renderWithIntl(
      <UnifiedDiffPreview diffText={modifiedDiff()} />
    )

    expect(screen.getByRole("separator")).toBeInTheDocument()

    const panes = container.querySelectorAll(".w-max")
    expect(panes).toHaveLength(2)
    for (const pane of panes) {
      // Short diffs still fill their half rather than huddling on the left.
      expect(pane).toHaveClass("min-w-full")
    }
    // Each pane holds one side of the pairing, not both.
    expect(panes[0]?.textContent).toContain("old line A")
    expect(panes[0]?.textContent).not.toContain("new line A")
    expect(panes[1]?.textContent).toContain("new line A")
    expect(panes[1]?.textContent).not.toContain("old line A")
  })

  it("holds a filler row open to a full line", () => {
    // A filler cell carries neither a number nor text, so its flex line has
    // nothing to give it height. The old single grid let the opposite cell
    // hold the row open; independent panes each lay out alone. Measured in
    // Chromium without the min-height: the filler row is 0px and every row
    // below the unpaired deletion sits 20px high on that side.
    localStorage.setItem("workspace:diff-view-mode", "split")
    const { container } = renderWithIntl(
      <UnifiedDiffPreview diffText={modifiedDiff()} />
    )

    // `modifiedDiff` pairs two deletions against one addition, so the second
    // pair leaves a filler on the right.
    const rows = container.querySelectorAll(".w-max > div")
    expect(rows).toHaveLength(8)
    for (const row of rows) expect(row).toHaveClass("min-h-[1.25rem]")
  })

  it("repeats the hunk marker in both panes so the rows stay level", () => {
    // A marker rendered once, spanning both sides, would push one pane's rows
    // down by its own height — the two sides scroll independently now, so the
    // only thing keeping them on the same baseline is an identical run of
    // boxes. Each side shows its own range.
    localStorage.setItem("workspace:diff-view-mode", "split")
    renderWithIntl(<UnifiedDiffPreview diffText={twoHunkDiff()} />)

    expect(screen.getByText("@@ -10,3 @@")).toBeInTheDocument()
    expect(screen.getByText("@@ +12,3 @@")).toBeInTheDocument()
  })

  it("still switches when persisting the choice throws", () => {
    // Storage disabled / over quota: the mode won't survive a reload, but the
    // button must not look dead. The broadcast carries the new mode instead of
    // making every listener re-read what was never written.
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError")
      })
    try {
      renderWithIntl(<UnifiedDiffPreview diffText={modifiedDiff()} />)

      fireEvent.click(
        screen.getByRole("button", { name: "Switch to side-by-side view" })
      )

      expect(screen.getAllByText("keep one")).toHaveLength(2)
    } finally {
      setItem.mockRestore()
    }
  })

  it("offers one button that names the view it switches to", () => {
    // Two buttons spent twice the header's width to say the same thing, and
    // one of them was always a no-op. The single button shows the layout it
    // takes you to, never the one already on screen.
    renderWithIntl(<UnifiedDiffPreview diffText={modifiedDiff()} />)

    expect(screen.getAllByRole("button")).toHaveLength(1)
    expect(
      screen.queryByRole("button", { name: "Switch to inline view" })
    ).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole("button", { name: "Switch to side-by-side view" })
    )

    expect(screen.getAllByRole("button")).toHaveLength(1)
    expect(
      screen.getByRole("button", { name: "Switch to inline view" })
    ).toBeInTheDocument()
  })

  it("puts the counters with the path and the toggle at the far right", () => {
    const { container } = renderWithIntl(
      <UnifiedDiffPreview diffText={modifiedDiff()} />
    )

    const header = container.querySelector("header")
    const toggle = screen.getByRole("button", {
      name: "Switch to side-by-side view",
    })
    expect(header).toContainElement(toggle)

    // Reading order: badge, path, +1, -2, toggle.
    const cells = Array.from(header?.children ?? []).map((child) =>
      child.textContent?.trim()
    )
    expect(cells).toEqual(["Modified", "app.ts", "+1-2", ""])
    expect(header?.lastElementChild).toBe(toggle)
  })

  it("hides the toggle for a diff that has no side to split", () => {
    // A pure new-file diff renders as plain content in both modes, so the
    // control would be a visible no-op.
    renderWithIntl(<UnifiedDiffPreview diffText={newFileDiff(3)} />)

    expect(
      screen.queryByRole("button", { name: "Switch to side-by-side view" })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Switch to inline view" })
    ).not.toBeInTheDocument()
  })

  it("keeps the toggle when a new file is mixed with a modified one", () => {
    renderWithIntl(
      <UnifiedDiffPreview diffText={`${newFileDiff(2)}\n${modifiedDiff()}`} />
    )

    expect(
      screen.getByRole("button", { name: "Switch to side-by-side view" })
    ).toBeInTheDocument()
  })
})

describe("toSplitRows", () => {
  it("spans context rows across both sides", () => {
    const [row] = toSplitRows(modifiedRows().slice(0, 1))

    expect(row?.left).toEqual({
      line: 1,
      text: "keep one",
      marker: "none",
    })
    expect(row?.right).toEqual({
      line: 1,
      text: "keep one",
      marker: "none",
    })
  })

  it("pairs a delete-run with its add-run positionally", () => {
    const rows = toSplitRows(modifiedRows().slice(1, 4))

    expect(rows).toHaveLength(2)
    // First pair: old A faces new A.
    expect(rows[0]?.left).toMatchObject({
      text: "old line A",
      marker: "deleted",
    })
    expect(rows[0]?.right).toMatchObject({
      text: "new line A",
      marker: "added",
    })
    // The longer delete run leaves a filler cell on the right.
    expect(rows[1]?.left).toMatchObject({ text: "old line B" })
    expect(rows[1]?.right).toEqual({
      line: null,
      text: null,
      marker: "none",
    })
  })

  it("spans a 'modified' row instead of spinning on it", () => {
    // `ParsedDiffRow` has a fourth type the current classifier never emits.
    // Pairing must still consume it: a row that matches neither the delete run
    // nor the add run would leave the cursor parked and hang the tab in a
    // synchronous loop no test timeout can interrupt.
    const rows = toSplitRows([
      { type: "modified", text: "touched", sign: " ", oldLine: 7, newLine: 7 },
      { type: "added", text: "after", sign: "+", oldLine: null, newLine: 8 },
    ])

    expect(rows).toHaveLength(2)
    expect(rows[0]?.left).toMatchObject({ text: "touched", line: 7 })
    expect(rows[0]?.right).toMatchObject({ text: "touched", line: 7 })
    expect(rows[1]?.right).toMatchObject({ text: "after", marker: "added" })
  })

  it("gives a pure insertion an empty left cell", () => {
    const rows = toSplitRows([
      { type: "added", text: "fresh", sign: "+", oldLine: null, newLine: 5 },
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0]?.left).toEqual({ line: null, text: null, marker: "none" })
    expect(rows[0]?.right).toMatchObject({ text: "fresh", line: 5 })
  })
})
