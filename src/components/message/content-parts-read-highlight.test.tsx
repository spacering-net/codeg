import { type ReactNode } from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * An opened Read shows the file's lines in the colours of its language, as
 * the file viewer and the transcript's code blocks do; a file in a language
 * the highlighter does not know stays plain.
 */

// A stand-in for shiki: every line one token, in one colour.
const shiki = vi.hoisted(() => ({
  codeToTokens: vi.fn((code: string) => ({
    fg: "#24292e",
    bg: "#fff",
    tokens: code.split("\n").map((content) =>
      content
        ? [
            {
              content,
              offset: 0,
              color: "#d73a49",
              htmlStyle: { color: "#d73a49", "--shiki-dark": "#f97583" },
            },
          ]
        : []
    ),
  })),
}))

vi.mock("shiki", () => ({
  bundledLanguagesInfo: [{ id: "typescript", aliases: ["ts"] }],
  createHighlighter: async () => ({
    codeToTokens: shiki.codeToTokens,
    getLoadedLanguages: () => ["typescript"],
    getLoadedThemes: () => ["github-light", "github-dark"],
    loadLanguage: async () => {},
    loadTheme: async () => {},
  }),
}))

vi.mock("@/components/ai-elements/link-safety", () => ({
  FilePathLink: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
  ),
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

function read(path: string, startLine: number, content: string) {
  return {
    type: "tool-call",
    toolCallId: `toolu_read_${path}`,
    toolName: "Read",
    input: JSON.stringify({ file_path: path }),
    state: "output-available",
    output: JSON.stringify({ start_line: startLine, content }),
  } satisfies AdaptedContentPart
}

function renderReads(...parts: AdaptedContentPart[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {parts.map((part) => (
        <ContentPartsRenderer
          key={part.type === "tool-call" ? part.toolCallId : ""}
          parts={[part]}
          role="assistant"
        />
      ))}
    </NextIntlClientProvider>
  )
}

/** Open the read of `name`: its row is the button that names the file. */
function open(name: RegExp) {
  fireEvent.click(screen.getByRole("button", { name }))
}

/** The text of every span drawn in a colour of the highlighter's, in order. */
function colouredText(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("span"))
    .filter((span) => span.style.color && span.style.color !== "inherit")
    .map((span) => span.textContent ?? "")
}

beforeEach(() => {
  shiki.codeToTokens.mockClear()
})

describe("Read output highlighting", () => {
  it("colours the lines a read shows in its file's language", async () => {
    renderReads(read("/w/src/total.ts", 5, "let total = 0\ntotal += 1\n"))
    open(/total\.ts/)

    await waitFor(() =>
      expect(colouredText()).toEqual(["let total = 0", "total += 1"])
    )
    expect(shiki.codeToTokens).toHaveBeenCalledWith(
      "let total = 0\ntotal += 1",
      expect.objectContaining({ lang: "typescript" })
    )
    // Still numbered from where the read started.
    expect(screen.getByText("5")).toBeInTheDocument()
    expect(screen.getByText("6")).toBeInTheDocument()
  })

  it("leaves a file in a language it doesn't know as plain text", async () => {
    renderReads(
      read("/w/src/known.ts", 1, "const known = true"),
      read("/w/logs/build.log", 1, "plain build output")
    )
    open(/known\.ts/)
    open(/build\.log/)

    // By the time the file it knows is coloured, the other would have been.
    await waitFor(() => expect(colouredText()).toEqual(["const known = true"]))
    expect(shiki.codeToTokens).not.toHaveBeenCalledWith(
      expect.stringContaining("plain build output"),
      expect.anything()
    )
    expect(screen.getByText("plain build output")).toBeInTheDocument()
  })
})
