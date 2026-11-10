import { type ReactElement, type ReactNode } from "react"
import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

// FilePathLink drives the real workspace file panel (active-folder context +
// toasts). Stub it to a button that exposes the path/line it would open, which
// is exactly what this card is responsible for wiring up.
vi.mock("@/components/ai-elements/link-safety", () => ({
  FilePathLink: ({
    filePath,
    line,
    children,
  }: {
    filePath: string
    line?: number | null
    children: ReactNode
  }) => (
    <button data-path={filePath} data-line={line ?? ""}>
      {children}
    </button>
  ),
}))

// CodeBlock async-highlights via Shiki; the fallback path only needs to prove
// the raw text is handed through verbatim.
vi.mock("@/components/ai-elements/code-block", () => ({
  CodeBlock: ({ code }: { code: string }) => (
    <pre data-testid="code-block">{code}</pre>
  ),
}))

import { SearchResultsOutput } from "./search-results-output"
import enMessages from "@/i18n/messages/en.json"

function renderOutput(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

describe("SearchResultsOutput", () => {
  it("groups matches per file with clickable paths and line numbers", () => {
    renderOutput(
      <SearchResultsOutput
        text={[
          "src/a.ts:12:  const x = 1",
          "src/a.ts:40:  const y = 2",
          "src/b.ts:7:export {}",
        ].join("\n")}
      />
    )

    expect(screen.getByText("3 matches in 2 files")).toBeInTheDocument()

    const fileLink = screen.getByRole("button", { name: "src/a.ts" })
    expect(fileLink).toHaveAttribute("data-path", "src/a.ts")

    // Each match row links to its own line in the same file.
    const lineLink = screen.getByRole("button", { name: "40" })
    expect(lineLink).toHaveAttribute("data-path", "src/a.ts")
    expect(lineLink).toHaveAttribute("data-line", "40")

    // Match text is shown with its leading indentation trimmed away.
    expect(screen.getByText("const y = 2")).toBeInTheDocument()
  })

  // It is drawn inside a row's panel, which caps the height and scrolls: a
  // scroll box of its own would nest a second scrollbar inside that one.
  it("scrolls in its panel, with no scroll box of its own", () => {
    const { container } = renderOutput(
      <SearchResultsOutput
        text={Array.from({ length: 40 }, (_, i) => `src/f${i}.ts`).join("\n")}
      />
    )
    expect(screen.getByText("40 files")).toBeInTheDocument()
    for (const node of container.querySelectorAll("*")) {
      expect(node.getAttribute("class") ?? "").not.toMatch(
        /overflow-(auto|scroll|y-auto)|max-h-/
      )
    }
  })

  it("highlights literal occurrences of the query", () => {
    const { container } = renderOutput(
      <SearchResultsOutput
        text="Foo.java:42:  Tests run: 5, Failures: 0"
        query="Tests run:"
      />
    )

    const marks = container.querySelectorAll("mark")
    expect(marks).toHaveLength(1)
    expect(marks[0].textContent).toBe("Tests run:")
  })

  it("does not highlight a regex query that never occurs literally", () => {
    const { container } = renderOutput(
      <SearchResultsOutput text="a.ts:1:const x = 1" query="const\s+\w+" />
    )
    expect(container.querySelectorAll("mark")).toHaveLength(0)
  })

  it("renders a bare path list as a clickable file list", () => {
    renderOutput(
      <SearchResultsOutput text={["src/a.ts", "src/b.tsx"].join("\n")} />
    )

    expect(screen.getByText("2 files")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "src/a.ts" })).toHaveAttribute(
      "data-path",
      "src/a.ts"
    )
    expect(
      screen.getByRole("button", { name: "src/b.tsx" })
    ).toBeInTheDocument()
  })

  it("reports an empty result as no matches instead of blank JSON", () => {
    // codex sends `{"exit_code":1,"formatted_output":""}` for a search that hit
    // nothing; the unwrapped text is the empty string.
    renderOutput(<SearchResultsOutput text="" />)
    expect(screen.getByText("No matches")).toBeInTheDocument()
    expect(screen.queryByTestId("code-block")).not.toBeInTheDocument()
  })

  it("falls back to the plain code block for unrecognised output", () => {
    const text = "Found 3 files\n(Results are truncated, use a narrower path.)"
    renderOutput(<SearchResultsOutput text={text} />)

    expect(screen.getByTestId("code-block")).toHaveTextContent("Found 3 files")
    expect(screen.queryByText("No matches")).not.toBeInTheDocument()
  })

  it("shows rg warnings as notes alongside the parsed matches", () => {
    renderOutput(
      <SearchResultsOutput
        text={[
          "a.ts:1:x",
          "b.ts:2:y",
          "c.ts:3:z",
          "d.ts:4:w",
          "rg: e.ts: No such file or directory",
        ].join("\n")}
      />
    )

    expect(screen.getByText("4 matches in 4 files")).toBeInTheDocument()
    expect(
      screen.getByText("rg: e.ts: No such file or directory")
    ).toBeInTheDocument()
  })
})

describe("SearchResultsOutput — hostile input", () => {
  it("bounds the number of highlight nodes for a short query on a long line", () => {
    // `rg "e"` against a minified line would otherwise mint one <mark> per
    // occurrence and lock up the webview.
    const line = `min.js:1:${"e".repeat(5000)}`
    const { container } = renderOutput(
      <SearchResultsOutput text={line} query="e" />
    )
    const marks = container.querySelectorAll("mark")
    expect(marks.length).toBeGreaterThan(0)
    expect(marks.length).toBeLessThanOrEqual(100)
    // The tail past the cap is still rendered, just unhighlighted.
    expect(container.textContent).toContain("e".repeat(200))
  })
})
