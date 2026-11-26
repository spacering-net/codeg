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

  it("keeps decoded '#' and '?' in the file name on the preview-root fallback", async () => {
    mocks.readFileBase64.mockImplementation(async (path: string) => {
      if (path !== "/repo/assets/chart#1?.svg") throw new Error("ENOENT")
      return "QUFB"
    })

    const { container } = renderDocument(
      "![c](/assets/chart%231%3F.svg?v=2#view)"
    )

    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        "data:image/svg+xml;base64,QUFB"
      )
    )
    expect(mocks.readFileBase64.mock.calls.map(([path]) => path)).toEqual([
      "/assets/chart#1?.svg",
      "/repo/assets/chart#1?.svg",
    ])
  })

  it("never turns an encoded separator into a network path", async () => {
    const { container } = renderDocument(
      [
        "![a](/%2Fhost.invalid/share/a.png)",
        "![b](/%5C%5Chost.invalid/share/b.png)",
      ].join("\n\n")
    )

    await waitFor(() =>
      expect(mocks.readFileBase64.mock.calls.length).toBeGreaterThan(0)
    )
    expect(container.querySelectorAll("img")).toHaveLength(2)
    for (const [path] of mocks.readFileBase64.mock.calls) {
      expect(path).not.toMatch(/^[\\/]{2}/)
      expect(path).not.toContain("\\")
    }
  })

  it("treats protocol-relative destinations as web addresses", async () => {
    const { container } = renderDocument(
      [
        "![md](//cdn.invalid/assets/logo.png)",
        '<img src="//cdn.invalid/raw.png" alt="raw">',
        "[page](//cdn.invalid/page)",
        "![ref][logo]",
        '<img src = "//cdn.invalid/spaced.png" alt="spaced">',
        '<img data-src = "./placeholder.png" src="//cdn.invalid/data.png">',
        "[logo]: //cdn.invalid/ref.png",
      ].join("\n\n")
    )

    await waitFor(() =>
      expect(container.querySelectorAll("img")).toHaveLength(5)
    )
    expect(mocks.readFileBase64).not.toHaveBeenCalled()
    expect(
      Array.from(container.querySelectorAll("img")).map((img) =>
        img.getAttribute("src")
      )
    ).toEqual([
      "https://cdn.invalid/assets/logo.png",
      "https://cdn.invalid/raw.png",
      "https://cdn.invalid/ref.png",
      "https://cdn.invalid/spaced.png",
      "https://cdn.invalid/data.png",
    ])
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "https://cdn.invalid/page"
    )
  })

  it.each([
    ["a literal percent escape", "/work/Design%20Notes"],
    ["spaces and parentheses", "/work/My Docs (v2)"],
    ["a hash sign", "/work/a#b"],
  ])(
    "resolves against a document directory containing %s",
    async (_label, dir) => {
      const openFilePreview = vi.fn()
      const { container } = render(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <MarkdownDocumentPreview
            content={"![a](./img/a.png)\n\n[guide](./guide.md)"}
            fileDir={dir}
            previewRoot={dir}
            openFilePreview={openFilePreview}
          />
        </NextIntlClientProvider>
      )

      await waitFor(() =>
        expect(container.querySelector("img")?.getAttribute("src")).toBe(
          "data:image/png;base64,QUFB"
        )
      )
      expect(mocks.readFileBase64).toHaveBeenCalledWith(`${dir}/img/a.png`)
      fireEvent.click(container.querySelector("a")!)
      expect(openFilePreview).toHaveBeenCalledWith(`${dir}/guide.md`)
    }
  )

  it("resolves Windows drive paths without a cross-drive fallback", async () => {
    mocks.readFileBase64.mockRejectedValue(new Error("ENOENT"))
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    renderDocument("![a](../../other/x.png)", {
      fileDir: "C:/repo/docs",
      previewRoot: "C:/repo",
    })

    await waitFor(() => expect(errorSpy).toHaveBeenCalled())
    expect(mocks.readFileBase64.mock.calls.map(([path]) => path)).toEqual([
      "C:/other/x.png",
    ])
    errorSpy.mockRestore()
  })

  it("leaves references inside code blocks and inline code untouched", async () => {
    const fenced = [
      '<img src="//localhost:8080/logo.png">',
      "![a](./img/a.png)",
      "[b](/guide.md)",
    ].join("\n")
    const { container } = renderDocument(
      ["```html", fenced, "```", "", "Inline `![c](./img/c.png)` here."].join(
        "\n"
      )
    )

    await waitFor(() => expect(container.querySelector("pre")).not.toBeNull())
    // The highlighter renders each line as its own span, without newlines.
    expect(container.querySelector("pre")?.textContent).toBe(
      fenced.replace(/\n/g, "")
    )
    expect(container.textContent).toContain("![c](./img/c.png)")
    expect(mocks.readFileBase64).not.toHaveBeenCalled()
  })

  it("masks only real fences: prose tildes mask nothing, nested fences mask whole", async () => {
    const nested = [
      "````md",
      "```html",
      '<img src="//localhost:8080/logo.png">',
      "```",
      "![n](./img/n.png)",
      "````",
    ].join("\n")
    const { container } = renderDocument(
      [
        "The separator is ~~~ in this example.",
        "",
        "![logo](./assets/logo.png)",
        "",
        "Use ~~~ as the closing separator.",
        "",
        nested,
      ].join("\n")
    )

    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        "data:image/png;base64,QUFB"
      )
    )
    expect(mocks.readFileBase64.mock.calls.map(([path]) => path)).toEqual([
      "/repo/docs/assets/logo.png",
    ])
    expect(container.querySelector("pre")?.textContent).toBe(
      nested.split("\n").slice(1, -1).join("")
    )
  })

  it.each([
    ["an empty fence", "~~~txt\n~~~"],
    ["a fence-like line inside an HTML comment", "<!--\n~~~ notes\n-->"],
    ["a fence in a list item that ends on dedent", "- item\n\n  ```\n  code"],
  ])("does not mask live content after %s", async (_label, before) => {
    const { container } = renderDocument(
      `${before}\n\n![logo](./assets/logo.png)\n`
    )

    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        "data:image/png;base64,QUFB"
      )
    )
    expect(mocks.readFileBase64.mock.calls.map(([path]) => path)).toEqual([
      "/repo/docs/assets/logo.png",
    ])
  })

  it("leaves indented code blocks untouched", async () => {
    const { container } = renderDocument(
      'Example:\n\n    <img src = "//localhost:8080/logo.png">\n    ![a](./img/a.png)\n'
    )

    await waitFor(() => expect(container.querySelector("pre")).not.toBeNull())
    expect(container.querySelector("pre")?.textContent).toContain(
      '<img src = "//localhost:8080/logo.png">'
    )
    expect(container.querySelector("pre")?.textContent).toContain(
      "![a](./img/a.png)"
    )
    expect(mocks.readFileBase64).not.toHaveBeenCalled()
  })

  it("rewrites images in a GFM footnote's indented paragraph", async () => {
    const { container } = renderDocument(
      "Note[^1].\n\n[^1]: First.\n\n    ![logo](./assets/logo.png)\n"
    )

    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        "data:image/png;base64,QUFB"
      )
    )
    expect(mocks.readFileBase64.mock.calls.map(([path]) => path)).toEqual([
      "/repo/docs/assets/logo.png",
    ])
  })

  it("keeps code-span offsets right in a document with a byte-order mark", () => {
    const openFilePreview = vi.fn()
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MarkdownDocumentPreview
          content={"\uFEFF[`guide.md`](./guide.md)"}
          fileDir="/repo/docs"
          previewRoot="/repo"
          openFilePreview={openFilePreview}
        />
      </NextIntlClientProvider>
    )

    fireEvent.click(container.querySelector("a")!)
    expect(openFilePreview).toHaveBeenCalledWith("/repo/docs/guide.md")
  })
})
