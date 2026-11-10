import { type ReactElement, type ReactNode } from "react"
import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

vi.mock("streamdown", () => ({
  Streamdown: ({
    children,
    mode,
    parseIncompleteMarkdown,
  }: {
    children: ReactNode
    mode?: string
    parseIncompleteMarkdown?: boolean
  }) => (
    <div
      data-testid="streamdown-root"
      data-mode={mode}
      data-parse-incomplete={String(parseIncompleteMarkdown)}
    >
      {children}
    </div>
  ),
  defaultRemarkPlugins: {},
  defaultRehypePlugins: {},
}))

vi.mock("@streamdown/cjk", () => ({ cjk: {} }))
vi.mock("@streamdown/math", () => ({ createMathPlugin: () => ({}) }))
vi.mock("@streamdown/mermaid", () => ({ mermaid: {} }))
vi.mock("@/lib/code-highlighter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/code-highlighter")>()),
  createCodePlugin: async () => ({
    name: "shiki",
    type: "code-highlighter",
    highlight: vi.fn(),
    supportsLanguage: vi.fn(() => true),
    getSupportedLanguages: () => [],
    getThemes: () => ["github-light", "github-dark"],
  }),
}))

vi.mock("@/components/ai-elements/link-safety", () => ({
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))

import enMessages from "@/i18n/messages/en.json"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import { CompletedTurnContent } from "./completed-turn-content"

function renderWithIntl(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

const PROGRESS_TEXT = "Looking at `_meta` now."
const ANSWER_TEXT = "see `tools/dsv4-c1/*` please."

// A reply with work behind it AND trailing prose, i.e. the foldable shape.
// Both halves are rendered by their own ContentPartsRenderer, so both have to
// be told whether the turn is still being written.
const freshParts = (): AdaptedContentPart[] => [
  { type: "text", text: PROGRESS_TEXT },
  {
    type: "tool-call",
    toolCallId: "call-1",
    toolName: "Read",
    input: '{"file_path":"src/app.tsx"}',
    state: "output-available",
    output: "source",
  },
  { type: "text", text: ANSWER_TEXT },
]

// Streamdown's incomplete-markdown repair (remend) appends a closer after spans
// that are already complete — a glob, an `_meta`-style identifier — so it may
// only run while the text is still growing. A live reply that has already made
// a tool call renders through the FOLDABLE branch, not the plain early return,
// so the split halves each need the answer independently.
describe("CompletedTurnContent markdown mode", () => {
  it("keeps a live reply's prose in streaming mode on both sides of the fold", () => {
    renderWithIntl(
      <CompletedTurnContent parts={freshParts()} completed={false} />
    )

    // Open by default while the reply is being written, so the folded progress
    // half is mounted too.
    expect(screen.getByText(PROGRESS_TEXT)).toHaveAttribute(
      "data-mode",
      "streaming"
    )
    expect(screen.getByText(ANSWER_TEXT)).toHaveAttribute(
      "data-mode",
      "streaming"
    )
  })

  it("drops a settled reply to static so remend cannot append leftover * / _", () => {
    renderWithIntl(
      <CompletedTurnContent parts={freshParts()} completed durationMs={3_000} />
    )

    const answer = screen.getByText(ANSWER_TEXT)
    expect(answer).toHaveAttribute("data-mode", "static")
    expect(answer).toHaveAttribute("data-parse-incomplete", "false")
  })
})
