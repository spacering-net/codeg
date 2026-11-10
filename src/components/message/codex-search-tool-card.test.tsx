import { type ReactNode } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

/**
 * End-to-end check of the codex `search` command-action row: the tool call
 * carries no rawInput (only codex-acp's human title) and completes with a
 * `{formatted_output, exit_code}` envelope. Once this showed a wrench icon, a
 * title polluted with the first line of output, and the raw JSON envelope as
 * its result.
 */

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
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))

vi.mock("@/components/ai-elements/code-block", () => ({
  CodeBlock: ({ code }: { code: string }) => (
    <pre data-testid="code-block">{code}</pre>
  ),
}))

vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: string }) => (
    <div>{children}</div>
  ),
}))

import { ContentPartsRenderer } from "./content-parts-renderer"
import enMessages from "@/i18n/messages/en.json"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"

/** Search rows start folded (a failure opens itself); open the row so its
 *  panel is asserted on. */
function renderParts(parts: AdaptedContentPart[], expand = true) {
  const result = render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ContentPartsRenderer parts={parts} role="assistant" />
    </NextIntlClientProvider>
  )
  const header = screen.getAllByRole("button")[0]!
  if (expand && header.getAttribute("aria-expanded") === "false") {
    fireEvent.click(header)
  }
  return result
}

/** The row's header line, as one string. */
function headerText(): string {
  return document.querySelector("li > button")?.textContent ?? ""
}

/** What the live store hands the adapter for a codex search command action. */
function searchPart(
  pattern: string,
  path: string | null,
  formattedOutput: string,
  exitCode = 0
): AdaptedContentPart {
  const output = JSON.stringify({
    exit_code: exitCode,
    formatted_output: formattedOutput,
  })
  // codex derives the tool status from the exit code, so a nonzero exit (which
  // includes rg/grep's "no matches" = 1) arrives as a failed call — the adapter
  // then mirrors the same envelope onto both output and errorText.
  const failed = exitCode !== 0
  return {
    type: "tool-call",
    toolCallId: "tc-search",
    toolName: "grep",
    input: JSON.stringify(path ? { pattern, path } : { pattern }),
    state: failed ? "output-error" : "output-available",
    output,
    ...(failed ? { errorText: output } : {}),
  }
}

describe("codex search command-action row", () => {
  it("titles the row from the pattern and never shows the raw envelope", () => {
    renderParts([
      searchPart(
        "Tests run:",
        "com.forwayaudio.app",
        "Foo.java:42:  Tests run: 5, Failures: 0\nBar.java:17:  Tests run: 3"
      ),
    ])

    expect(headerText()).toContain("SearchedTests run:")
    // The scope path shows beside the pattern.
    expect(screen.getByText("com.forwayaudio.app")).toBeInTheDocument()
    // No `{"exit_code":…}` anywhere — the defect this was rewritten for.
    expect(document.body.textContent).not.toContain("exit_code")
    expect(document.body.textContent).not.toContain("formatted_output")
  })

  it("renders the unwrapped output as grouped, clickable matches", () => {
    renderParts([
      searchPart(
        "Tests run:",
        "app",
        "Foo.java:42:  Tests run: 5\nFoo.java:88:  Tests run: 12"
      ),
    ])

    expect(screen.getByText("2 matches in 1 file")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Foo.java" })).toHaveAttribute(
      "data-path",
      "Foo.java"
    )
    expect(screen.getByRole("button", { name: "88" })).toHaveAttribute(
      "data-line",
      "88"
    )
  })

  it("reports a no-match search as an empty result, not a red error", () => {
    // exit 1 + no output is rg/grep's "found nothing", which codex reports as a
    // FAILED call — it must not render as an error envelope dump.
    const { container } = renderParts([searchPart("nope", null, "", 1)])
    expect(screen.getByText("no matches")).toBeInTheDocument()
    expect(container.querySelector("li")).toHaveAttribute(
      "data-status",
      "succeeded"
    )
    expect(document.body.textContent).not.toContain("exit_code")
    expect(container.querySelector(".text-destructive")).toBeNull()
    expect(container.querySelector(".text-tone-danger")).toBeNull()
  })

  it("keeps a genuine search failure on the error path", () => {
    // exit 2 with stderr text is a real rg error; it stays in the error block
    // rather than being passed off as an empty result.
    renderParts([searchPart("[bad", null, "rg: regex parse error", 2)])
    expect(screen.queryByText("no matches")).not.toBeInTheDocument()
    expect(document.body.textContent).toContain("rg: regex parse error")
  })

  it("titles a list-files command action by its path", () => {
    renderParts([
      {
        type: "tool-call",
        toolCallId: "tc-ls",
        toolName: "glob",
        input: JSON.stringify({ path: "src/components" }),
        state: "output-available",
        output: JSON.stringify({
          exit_code: 0,
          formatted_output: "src/components/a.tsx\nsrc/components/b.tsx",
        }),
      },
    ])

    expect(headerText()).toContain("Listedsrc/components")
    expect(headerText()).toContain("2 files")
    expect(document.body.textContent).not.toContain("formatted_output")
  })
})

describe("codex search command-action unwrapping is lossless", () => {
  it("keeps a matched line that is literally 'Output:'", () => {
    // The command path's unconditional CLI-envelope strip ate this line (and the
    // whole result when it was the only hit).
    renderParts([searchPart("Output", null, "Output:\nreal.ts:1:hit")])
    expect(screen.getByTestId("code-block")).toHaveTextContent("Output:")
    expect(screen.queryByText("No matches")).not.toBeInTheDocument()
  })

  it("keeps code-fence characters that were the search target", () => {
    // `grep -h '```' README.md` — the fence stripper used to delete these.
    renderParts([searchPart("```", null, "```ts\nconst x = 1\n```")])
    expect(screen.getByTestId("code-block")).toHaveTextContent("```ts")
  })

  it("does not read a non-codex JSON payload as an empty search", () => {
    // Only the exact {formatted_output, exit_code} pair is an envelope; a bare
    // {"exit_code":0} used to collapse to "No matches".
    renderParts([
      {
        type: "tool-call",
        toolCallId: "tc-other",
        toolName: "grep",
        input: JSON.stringify({ pattern: "x" }),
        state: "output-available",
        output: JSON.stringify({ exit_code: 0 }),
      },
    ])
    expect(screen.queryByText("No matches")).not.toBeInTheDocument()
    expect(screen.getByTestId("code-block")).toHaveTextContent("exit_code")
  })

  it("keeps a failed list-files (glob) exit 1 on the error path", () => {
    // exit 1 means "nothing selected" only for grep-likes. For ls/find it is a
    // real failure — e.g. `ls missing 2>/dev/null` (empty output, exit 1).
    const output = JSON.stringify({ exit_code: 1, formatted_output: "" })
    renderParts([
      {
        type: "tool-call",
        toolCallId: "tc-ls-fail",
        toolName: "glob",
        input: JSON.stringify({ path: "missing" }),
        state: "output-error",
        output,
        errorText: output,
      },
    ])
    expect(screen.queryByText("No matches")).not.toBeInTheDocument()
  })
})

describe("codex search output is not mistaken for CLI framing", () => {
  // `formatted_output` is the process's raw aggregatedOutput, and a single-file
  // grep prints matches with no `<path>:` prefix — so a matched line can begin
  // with any of CLI_META_LINE_RE's metadata words. None of them may be stripped.
  it.each([
    ["Chunk ID:", "Chunk ID: 065b2b"],
    ["Wall time:", "Wall time: 0.05s"],
    ["Exit code:", "Exit code: 0"],
    ["Total output lines:", "Total output lines: 1134"],
    ["Process exited with code", "Process exited with code 0"],
  ])("keeps a matched line starting with %s", (_label, line) => {
    renderParts([
      searchPart(line.split(":")[0], null, `${line}\n${line} again`),
    ])
    expect(screen.queryByText("No matches")).not.toBeInTheDocument()
    expect(screen.getByTestId("code-block")).toHaveTextContent(line)
  })
})
