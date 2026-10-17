import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import { ToolOutput } from "./tool"
import enMessages from "@/i18n/messages/en.json"

function renderOutput(output: string | null, errorText: string) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ToolOutput output={output} errorText={errorText} />
    </NextIntlClientProvider>
  )
}

describe("ToolOutput error text", () => {
  // claude-agent-acp fences a failed tool's result for markdown clients; the
  // card shows it as preformatted text, as the transcript records it. The
  // adapter puts the same text in the output, which the error then stands for.
  it("shows a fenced error without its fence", () => {
    const fenced = "```\nFile does not exist.\n```"
    const { container } = renderOutput(fenced, fenced)
    expect(screen.getByText("File does not exist.").textContent).toBe(
      "File does not exist."
    )
    expect(container.textContent).not.toContain("```")
  })

  it("reads a fenced JSON error as fields", () => {
    renderOutput(null, '```\n{"code": "ENOENT"}\n```')
    expect(screen.getByText("code")).toBeInTheDocument()
    expect(screen.getByText("ENOENT")).toBeInTheDocument()
  })
})
