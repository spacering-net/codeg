import { render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { MarkdownDocumentPreview } from "./markdown-document-preview"

const mocks = vi.hoisted(() => ({
  renderPlantUml: vi.fn(async () => '<svg viewBox="0 0 106 130"></svg>'),
}))

vi.mock("@/lib/api", () => ({ readFileBase64: vi.fn() }))
vi.mock("@/hooks/use-open-url-target", () => ({
  useOpenUrlTarget: () => vi.fn(),
  isPrimaryModifier: () => false,
}))
vi.mock("@/hooks/use-appearance", () => ({
  useAppearance: () => ({ isDarkMode: false }),
}))
// PlantUML's browser engine needs a canvas to measure text, which jsdom lacks.
vi.mock("@/components/ai-elements/plantuml-engine", () => ({
  renderPlantUml: mocks.renderPlantUml,
}))

function renderDocument(content: string) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MarkdownDocumentPreview
        content={content}
        fileDir="/repo/docs"
        previewRoot="/repo"
        openFilePreview={() => {}}
      />
    </NextIntlClientProvider>
  )
}

describe("MarkdownDocumentPreview diagrams", () => {
  it("draws a ```plantuml fence as a diagram, like a ```mermaid one", async () => {
    const { container } = renderDocument(
      [
        "# Design",
        "",
        "```plantuml",
        "@startuml",
        "Alice -> Bob: hello",
        "@enduml",
        "```",
        "",
      ].join("\n")
    )

    await waitFor(() =>
      expect(
        container.querySelector('[data-codeg="plantuml-block"] svg')
      ).not.toBeNull()
    )
    // Markdown hands over a fence's text with its closing newline.
    expect(mocks.renderPlantUml).toHaveBeenCalledWith(
      "@startuml\nAlice -> Bob: hello\n@enduml\n",
      expect.objectContaining({ dark: false })
    )
    // The fence is drawn, not left as a code block showing its source.
    expect(screen.queryByText(/Alice -> Bob: hello/)).toBeNull()
  })
})
