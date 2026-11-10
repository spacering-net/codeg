import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { ResultBody } from "./result-body"

describe("ResultBody", () => {
  // claude-agent-acp fences a failed tool's result for markdown clients; the
  // row shows it as preformatted text, as the transcript records it.
  it("shows a fenced error without its fence", () => {
    const { container } = render(
      <ResultBody text={"```\nFile does not exist.\n```"} tone="danger" />
    )
    expect(screen.getByText("File does not exist.").textContent).toBe(
      "File does not exist."
    )
    expect(container.textContent).not.toContain("```")
  })

  it("reads a fenced JSON error as JSON", () => {
    const { container } = render(
      <ResultBody text={'```\n{"code": "ENOENT"}\n```'} tone="danger" />
    )
    expect(container.textContent).toBe('{\n  "code": "ENOENT"\n}')
  })

  it("draws a large JSON result as a tree", () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({
      id: i,
      name: `n${i}`,
    }))
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ResultBody text={JSON.stringify(rows)} />
      </NextIntlClientProvider>
    )
    // Not a printed dump: a tree to unfold.
    expect(container.querySelector("pre")).toBeNull()
    expect(container.textContent).not.toContain('"name": "n1"')
  })
})
