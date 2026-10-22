import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { DiffViewMode } from "@/lib/diff-view-mode-prefs"
import { CompactDiff } from "./compact-diff"

function renderDiff(diffText: string, view?: DiffViewMode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CompactDiff diffText={diffText} view={view} />
    </NextIntlClientProvider>
  )
}

/** Each drawn side-by-side row as `<left line>|<left text> ‖ <right ...>`;
 *  a filler cell is `·`. */
function drawnPairs(): string[] {
  const cells = Array.from(document.querySelectorAll("[data-diff-cell]"))
  const show = (cell: Element) =>
    cell.getAttribute("data-diff-cell") === "filler"
      ? "·"
      : Array.from(cell.children)
          .map((part) => part.textContent)
          .join("|")
  const pairs: string[] = []
  for (let i = 0; i < cells.length; i += 2) {
    pairs.push(`${show(cells[i])} ‖ ${show(cells[i + 1])}`)
  }
  return pairs
}

/** Each drawn row as `<line> <sign> <text>`. */
function drawnRows(): string[] {
  return Array.from(document.querySelectorAll("[data-diff-row]")).map((row) =>
    Array.from(row.children)
      .map((cell) => cell.textContent)
      .join("|")
  )
}

describe("CompactDiff", () => {
  it("draws each row with one line number and its sign", () => {
    renderDiff(
      [
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -10,3 +10,3 @@",
        " keep",
        "-before",
        "+after",
      ].join("\n")
    )
    // A kept or added line is numbered in the new file, a removed one in the
    // old file.
    expect(drawnRows()).toEqual(["10||keep", "11|-|before", "11|+|after"])
  })

  it("separates hunks and takes off the indentation a hunk shares", () => {
    renderDiff(
      [
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,2 +1,2 @@",
        "     if (x) {",
        "-      go()",
        "+      stop()",
        "@@ -40,1 +40,1 @@",
        "-\tlast()",
        "+\tfirst()",
      ].join("\n")
    )
    expect(drawnRows()).toEqual([
      "1||if (x) {",
      "2|-|  go()",
      "2|+|  stop()",
      "40|-|last()",
      "40|+|first()",
    ])
    expect(screen.getByText("⋯")).toBeInTheDocument()
  })

  it("follows one edit with the next when a file changed several times", () => {
    renderDiff(
      [
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1,1 +1,1 @@",
        "-one",
        "+uno",
        "",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -9,1 +9,1 @@",
        "-two",
        "+dos",
      ].join("\n")
    )
    expect(drawnRows()).toEqual(["1|-|one", "1|+|uno", "9|-|two", "9|+|dos"])
    expect(screen.getAllByText("⋯")).toHaveLength(1)
  })

  it("holds back the rows of a long diff until asked", () => {
    const added = Array.from({ length: 450 }, (_, i) => `+line ${i + 1}`)
    renderDiff(
      ["--- /dev/null", "+++ b/big.txt", "@@ -0,0 +1,450 @@", ...added].join(
        "\n"
      )
    )
    expect(document.querySelectorAll("[data-diff-row]")).toHaveLength(400)
    fireEvent.click(screen.getByRole("button", { name: "Show 50 more lines" }))
    expect(document.querySelectorAll("[data-diff-row]")).toHaveLength(450)
  })

  it("lays a diff out side by side, each removed line facing its replacement", () => {
    renderDiff(
      [
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -10,4 +10,3 @@",
        " keep",
        "-before",
        "-gone",
        "+after",
        " tail",
      ].join("\n"),
      "split"
    )
    expect(document.querySelector("[data-diff-row]")).toBeNull()
    expect(drawnPairs()).toEqual([
      "10|keep ‖ 10|keep",
      "11|before ‖ 11|after",
      "12|gone ‖ ·",
      "13|tail ‖ 12|tail",
    ])
    expect(
      Array.from(document.querySelectorAll("[data-diff-cell]")).map((cell) =>
        cell.getAttribute("data-diff-cell")
      )
    ).toEqual([
      "none",
      "none",
      "deleted",
      "added",
      "deleted",
      "filler",
      "none",
      "none",
    ])
  })

  it("grows with its rows rather than scrolling within a box", () => {
    const added = Array.from({ length: 300 }, (_, i) => `+line ${i + 1}`)
    const { container } = renderDiff(
      ["--- /dev/null", "+++ b/big.txt", "@@ -0,0 +1,300 @@", ...added].join(
        "\n"
      )
    )
    expect(
      container.querySelector("[data-overlayscrollbars-initialize]")
    ).toBeNull()
    expect(container.querySelector("[class*=max-h-]")).toBeNull()
    expect(document.querySelectorAll("[data-diff-row]")).toHaveLength(300)
  })

  it("shows text it can't read as a diff as it came", () => {
    renderDiff("No diff here, just words")
    expect(screen.getByText("No diff here, just words")).toBeInTheDocument()
    expect(document.querySelector("[data-diff-row]")).toBeNull()
  })

  it("says so when there is no diff at all", () => {
    renderDiff("")
    expect(screen.getByText("No diff data")).toBeInTheDocument()
  })
})
