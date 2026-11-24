import { type ReactNode } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

/**
 * Codex "code mode" cards.
 *
 * Codex now wraps every tool call in a JS script. The history parser
 * (`src-tauri/src/parsers/codex_code_mode.rs`) recovers the inner
 * `tools.<name>(…)` calls so the ordinary cards keep working, and emits a
 * `codex_script` card only for the scripts it could not decompose. Before that,
 * every codex history card was titled `const r = await tools.exec_command({`
 * and rendered the JS as a shell command.
 */

vi.mock("@/components/ai-elements/link-safety", () => ({
  FilePathLink: ({
    filePath,
    children,
  }: {
    filePath: string
    children: ReactNode
  }) => <button data-path={filePath}>{children}</button>,
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))

vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: string }) => (
    <div>{children}</div>
  ),
}))

import { ContentPartsRenderer } from "./content-parts-renderer"
import enMessages from "@/i18n/messages/en.json"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import { CODEX_SCRIPT_TOOL_NAME } from "@/lib/codex-code-mode"

function renderParts(parts: AdaptedContentPart[], expand = true) {
  const result = render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ContentPartsRenderer parts={parts} role="assistant" />
    </NextIntlClientProvider>
  )
  if (expand) fireEvent.click(screen.getAllByRole("button")[0])
  return result
}

const SCRIPT_SOURCE = `const cmds = [
  {cmd: "cargo test", workdir: "/repo"},
  {cmd: "cargo clippy", workdir: "/repo"}
];
const rs = await Promise.all(cmds.map(c => tools.exec_command(c)));`

function scriptPart(
  card: { source: string; title?: string; call_count?: number },
  output: string
): AdaptedContentPart {
  return {
    type: "tool-call",
    toolCallId: "tc-script",
    toolName: CODEX_SCRIPT_TOOL_NAME,
    input: JSON.stringify(card),
    state: "output-available",
    output,
  }
}

describe("codex code-mode cards", () => {
  it("renders an undecomposable script as JS, titled by its first command", () => {
    renderParts([
      scriptPart(
        { source: SCRIPT_SOURCE, title: "cargo test", call_count: 1 },
        "test result: ok. 12 passed"
      ),
    ])

    expect(screen.getByText("cargo test")).toBeInTheDocument()
    // The panel holds the script, then its output.
    const panel = document.querySelector(".activity-detail-box")!
    const script = panel.textContent!.indexOf("Promise.all")
    expect(script).toBeGreaterThan(-1)
    expect(
      panel.textContent!.indexOf("test result: ok. 12 passed")
    ).toBeGreaterThan(script)
    // No count of the script's tool call sites: a site in a `map` runs once
    // per item, so "1 tool call" undercounts what it ran.
    expect(panel.textContent).not.toContain("tool call")
  })

  it("falls back to a plain Script label when no command could be read", () => {
    renderParts([scriptPart({ source: "text('hi');", call_count: 0 }, "hi")])

    expect(screen.getByText("Script")).toBeInTheDocument()
    expect(document.body.textContent).toContain("text('hi');")
  })

  it("never renders the script as a shell command", () => {
    const { container } = renderParts([
      scriptPart({ source: SCRIPT_SOURCE, title: "cargo test" }, "done"),
    ])

    // The terminal card prefixes commands with `$ `; a JS script must not get
    // one, which is exactly what the `exec` → "bash" freeform match produced.
    expect(container.textContent).not.toContain("$ const")
  })

  it("renders an unwrapped inner call as its own tool card", () => {
    // What the parser emits for `tools.exec_command({cmd: "git status"})`:
    // the pre-code-mode shape (bare command), so the Terminal card matches.
    renderParts([
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "exec_command",
        input: "git status --short",
        state: "output-available",
        output: " M src/main.rs",
      },
    ])

    expect(screen.getByText("git status --short")).toBeInTheDocument()
    expect(document.body.textContent).toContain(" M src/main.rs")
    expect(document.body.textContent).not.toContain("await tools.")
  })

  /**
   * A script that fans a literal table of commands out through one
   * `tools.exec_command({cmd, …})` becomes one card per row. Codex truncates a
   * long combined output by deleting whole lines from the middle, taking some
   * of the row labels with it, so the parser marks what it could not place.
   */
  function fanoutPart(
    index: number,
    marks: Record<string, unknown>,
    output?: string
  ): AdaptedContentPart {
    return {
      type: "tool-call",
      toolCallId: `call_1#${index}`,
      toolName: "exec_command",
      input: `echo ${index}`,
      state: "output-available",
      output,
      meta: { "codeg.codexScript": marks },
    }
  }

  it("labels a fanned-out command with its table row name", () => {
    renderParts([
      fanoutPart(0, { label: "query-entry", truncated: true }, "line one"),
    ])

    expect(screen.getByText("query-entry")).toBeInTheDocument()
    expect(screen.getByText("echo 0")).toBeInTheDocument()
    expect(document.body.textContent).toContain("line one")
    // Its own output survived intact, so it is only told the blob was trimmed.
    expect(document.body.textContent).toContain("truncated")
    expect(document.body.textContent).not.toContain("none of the output")
  })

  it("says so when truncation left a command with no attributable output", () => {
    renderParts([
      fanoutPart(2, { label: "vo", outputMissing: true, truncated: true }),
    ])

    expect(screen.getByText("vo")).toBeInTheDocument()
    expect(document.body.textContent).toContain(
      "dropped this command's separator"
    )
  })

  it("names the commands whose output shares a card", () => {
    renderParts([
      fanoutPart(
        1,
        {
          label: "formula-service",
          sharedWith: ["vo", "formula-splice"],
          truncated: true,
        },
        "mixed output"
      ),
    ])

    expect(document.body.textContent).toContain(
      "Also contains the output of vo, formula-splice"
    )
    // The shared-boundary notice already reports the truncation.
    expect(document.body.textContent).not.toContain("dropped this command")
  })

  it("leaves ordinary cards untouched", () => {
    renderParts([
      {
        type: "tool-call",
        toolCallId: "call_9",
        toolName: "exec_command",
        input: "git status",
        state: "output-available",
        output: "clean",
        meta: { "codeg.delegation": { status: "done" } },
      },
    ])

    expect(document.body.textContent).not.toContain("truncated")
    expect(document.body.textContent).not.toContain("Also contains")
  })
})
