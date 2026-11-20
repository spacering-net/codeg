import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { MarkdownDocumentPreview } from "./markdown-document-preview"

const mocks = vi.hoisted(() => ({
  renderPlantUml: vi.fn(async () => '<svg viewBox="0 0 106 130"></svg>'),
  readFileBase64: vi.fn(async (path: string) => {
    void path
    return "QUFB"
  }),
}))

vi.mock("@/lib/api", () => ({ readFileBase64: mocks.readFileBase64 }))
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

function renderDocument(
  content: string,
  options: { fileDir?: string | null; previewRoot?: string | null } = {}
) {
  const { fileDir = "/repo/docs", previewRoot = "/repo" } = options
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MarkdownDocumentPreview
        content={content}
        fileDir={fileDir}
        previewRoot={previewRoot}
        openFilePreview={() => {}}
      />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  mocks.readFileBase64.mockReset()
  mocks.readFileBase64.mockResolvedValue("QUFB")
  mocks.renderPlantUml.mockClear()
})

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

describe("MarkdownDocumentPreview local images", () => {
  it("inlines relative and absolute SVG/PNG destinations", async () => {
    const { container } = renderDocument(
      [
        "![rel svg](./img/a.svg)",
        "![rel png](img/b.png)",
        "![abs svg](/repo/docs/c.svg)",
        "![abs png](/data/workspace/d.png)",
      ].join("\n\n")
    )

    await waitFor(() =>
      expect(
        Array.from(container.querySelectorAll("img")).every((img) =>
          img.getAttribute("src")?.startsWith("data:image/")
        )
      ).toBe(true)
    )

    expect(mocks.readFileBase64.mock.calls.map(([path]) => path)).toEqual([
      "/repo/docs/img/a.svg",
      "/repo/docs/img/b.png",
      "/repo/docs/c.svg",
      "/data/workspace/d.png",
    ])
    const srcs = Array.from(container.querySelectorAll("img")).map((img) =>
      img.getAttribute("src")
    )
    expect(srcs).toEqual([
      "data:image/svg+xml;base64,QUFB",
      "data:image/png;base64,QUFB",
      "data:image/svg+xml;base64,QUFB",
      "data:image/png;base64,QUFB",
    ])
  })

  it("still inlines images when the document directory is unknown", async () => {
    const { container } = renderDocument("![r](./img/a.svg)", {
      fileDir: null,
      previewRoot: "/repo",
    })

    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        "data:image/svg+xml;base64,QUFB"
      )
    )
    expect(mocks.readFileBase64).toHaveBeenCalledWith("/repo/img/a.svg")
  })

  it("falls back to the preview root for project-root-relative refs", async () => {
    mocks.readFileBase64.mockImplementation(async (path: string) => {
      if (path === "/assets/logo.png") throw new Error("ENOENT")
      return "QUFB"
    })

    const { container } = renderDocument("![logo](/assets/logo.png)")

    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        "data:image/png;base64,QUFB"
      )
    )
    expect(mocks.readFileBase64.mock.calls.map(([path]) => path)).toEqual([
      "/assets/logo.png",
      "/repo/assets/logo.png",
    ])
  })

  it("inlines <img src> written as raw HTML", async () => {
    const { container } = renderDocument('<img src="./img/a.svg" alt="a">', {
      fileDir: null,
      previewRoot: "/repo",
    })

    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        "data:image/svg+xml;base64,QUFB"
      )
    )
    expect(mocks.readFileBase64).toHaveBeenCalledWith("/repo/img/a.svg")
  })

  it("decodes percent-encoded non-ASCII image paths before reading", async () => {
    const { container } = renderDocument(
      "![架构图](./架构图-0.1.0全局架构.svg)",
      { fileDir: "/repo/方案设计/01-架构设计", previewRoot: "/repo" }
    )

    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        "data:image/svg+xml;base64,QUFB"
      )
    )
    // rehype-harden hands the component a percent-encoded URL; the backend
    // needs the real filesystem path (regression: 404 "File does not exist").
    expect(mocks.readFileBase64).toHaveBeenCalledWith(
      "/repo/方案设计/01-架构设计/架构图-0.1.0全局架构.svg"
    )
  })

  it("decodes percent-encoded non-ASCII local markdown links", () => {
    const openFilePreview = vi.fn()
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MarkdownDocumentPreview
          content="[架构文档](./架构设计说明.md)"
          fileDir="/repo/方案设计/01-架构设计"
          previewRoot="/repo"
          openFilePreview={openFilePreview}
        />
      </NextIntlClientProvider>
    )

    fireEvent.click(container.querySelector("a")!)
    expect(openFilePreview).toHaveBeenCalledWith(
      "/repo/方案设计/01-架构设计/架构设计说明.md"
    )
  })

  it("handles filenames that contain a percent sign", async () => {
    const { container } = renderDocument("![a](./100%.svg)")

    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        "data:image/svg+xml;base64,QUFB"
      )
    )
    expect(mocks.readFileBase64).toHaveBeenCalledWith("/repo/docs/100%.svg")
  })
})
