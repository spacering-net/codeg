import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  download: vi.fn(),
  copy: vi.fn(),
}))
vi.mock("@/lib/api", () => ({ readWorkspaceFileBase64: mocks.read }))
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("@/components/ai-elements/link-safety", () => ({
  useStreamdownLinkSafety: () => ({ enabled: false }),
  parseLocalFileTarget: () => null,
}))
vi.mock("@/components/message/image-actions", () => ({
  ImageActions: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
  useImageActions: () => ({
    canCopy: true,
    copy: mocks.copy,
    download: mocks.download,
  }),
}))

// Keep the real Streamdown parse/sanitize/harden pipeline. Mocking Streamdown
// would miss the exact failure that used to replace this image with text.
import { MessageResponse } from "./message"
import { MarkdownImageProvider } from "./markdown-local-image"
import { LOCAL_IMAGE_MAX_BYTES } from "@/lib/markdown-local-image"

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6TAAAAABJRU5ErkJggg=="

function preview(markdown: string, rootPath: string | null = "/repo") {
  return (
    <MarkdownImageProvider rootPath={rootPath}>
      <MessageResponse>{markdown}</MessageResponse>
    </MarkdownImageProvider>
  )
}

beforeEach(() => {
  mocks.read.mockReset().mockResolvedValue(PNG)
  mocks.copy.mockReset()
  mocks.download.mockReset()
})

describe("inline local images in real chat Markdown", () => {
  it.each([
    [
      "![Preview](</repo/My Images/preview.png>)",
      "/repo",
      "My Images/preview.png",
    ],
    ["![Preview](./images/preview.png)", "/repo", "images/preview.png"],
    ["![Preview](images/preview.png)", "/repo", "images/preview.png"],
    [
      "![Preview](<C:/My Project/_tmp/preview.png>)",
      "C:/My Project",
      "_tmp/preview.png",
    ],
    [
      "![Preview](file:///C:/My%20Project/_tmp/preview.png)",
      "C:/My Project",
      "_tmp/preview.png",
    ],
    [
      "![Preview](C:\\repo\\images\\preview.png)",
      "C:/repo",
      "images/preview.png",
    ],
    [
      "![Preview][shot]\n\n[shot]: ./images/preview.png",
      "/repo",
      "images/preview.png",
    ],
  ])(
    "renders %s without an Image blocked placeholder",
    async (markdown, root, path) => {
      const { container } = render(preview(markdown, root))
      await waitFor(() =>
        expect(screen.getByRole("img", { name: "Preview" })).toHaveAttribute(
          "src",
          `data:image/png;base64,${PNG}`
        )
      )
      expect(mocks.read).toHaveBeenCalledWith(root, path, LOCAL_IMAGE_MAX_BYTES)
      expect(container.textContent).not.toContain("Image blocked")
      expect(container.querySelector("img[src^='file:']")).toBeNull()
    }
  )

  it("opens the existing image dialog with copy and download actions", async () => {
    render(preview("![Preview](./preview.png)"))
    await screen.findByRole("button", { name: "Preview" })
    fireEvent.click(screen.getByRole("button", { name: "Preview" }))
    expect(screen.getByRole("dialog")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "copyImage" }))
    expect(mocks.copy).toHaveBeenCalledWith(
      expect.objectContaining({ data: PNG, name: "preview.png" })
    )
    fireEvent.click(screen.getByRole("button", { name: "downloadImage" }))
    expect(mocks.download).toHaveBeenCalledWith(
      expect.objectContaining({ data: PNG })
    )
  })

  it.each([
    "[![Preview](./preview.png)](https://example.com/gallery)",
    "[**![Preview](./preview.png)**](https://example.com/gallery)",
    "[![Preview](./preview.png)][gallery]\n\n[gallery]: https://example.com/gallery",
  ])("keeps a linked image in its original link: %s", async (markdown) => {
    const { container } = render(preview(markdown))
    await screen.findByRole("img", { name: "Preview" })
    expect(container.querySelector("button button")).toBeNull()
    expect(container.querySelector("[data-streamdown='link']")).toHaveAttribute(
      "title",
      "https://example.com/gallery"
    )
  })

  it("leaves remote images alone and does not interpret examples in code", async () => {
    const { container } = render(
      preview(
        "![Remote](https://example.com/preview.png)\n\n`![Inline](./inline.png)`\n\n```md\n![Code](./code.png)\n```"
      )
    )
    await waitFor(() =>
      expect(
        container.querySelector('img[src="https://example.com/preview.png"]')
      ).not.toBeNull()
    )
    expect(mocks.read).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(container.textContent).toContain("![Code](./code.png)")
    )
  })

  it.each([
    "../secret.png",
    "/repo-other/secret.png",
    "file:///private/secret.png",
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "./secret.json",
  ])(
    "does not read an unsafe or unsupported destination: %s",
    async (source) => {
      const { container } = render(preview(`![Unavailable](<${source}>)`))
      await waitFor(() =>
        expect(container.textContent).toContain("Unavailable")
      )
      expect(mocks.read).not.toHaveBeenCalled()
      expect(container.querySelector("img")).toBeNull()
    }
  )

  // CommonMark eats the `\` before a punctuation-initial Windows segment, so
  // `…\shots\.preview.png` arrives as `…\shots.preview.png` — a DIFFERENT file
  // that is still inside the root. Reading it would render the wrong picture
  // under the right alt text, which `[Image blocked: …]` never did.
  it.each([
    "![shot](C:\\repo\\shots\\.preview.png)",
    "![shot](<C:\\repo\\shots\\.preview.png>)",
    "![shot](C:\\repo\\shots\\_preview.png)",
    "![shot][s]\n\n[s]: C:\\repo\\shots\\.preview.png",
    "![shot](.\\shots\\.preview.png)",
    "![shot](a\\b\\.preview.png)",
    // The parsed destination keeps NO backslash in these — the only one was
    // the eaten separator — so the source, not the url, is what tells.
    "![shot](C:/repo/shots\\.preview.png)",
    "![shot](shots\\.preview.png)",
    "![shot][s]\n\n[s]: C:/repo/shots\\.preview.png",
  ])("refuses a Windows path the parser may have glued: %s", async (source) => {
    const { container } = render(preview(source, "C:/repo"))
    await waitFor(() => expect(container.textContent).toContain("shot"))
    expect(mocks.read).not.toHaveBeenCalled()
    expect(container.querySelector("img")).toBeNull()
  })

  it("still resolves a Windows path with no escape to lose", async () => {
    // The escape check is scoped to backslash destinations, and to the node
    // that carries one — an alt-text escape next to a forward-slash path is
    // not the parser gluing a directory onto a file name.
    render(
      preview(
        "![a \\* b](./preview.png)\n\n![shot](C:\\repo\\a\\b.png)",
        "C:/repo"
      )
    )
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2))
    expect(mocks.read).toHaveBeenCalledWith(
      "C:/repo",
      "preview.png",
      LOCAL_IMAGE_MAX_BYTES
    )
    expect(mocks.read).toHaveBeenCalledWith(
      "C:/repo",
      "a/b.png",
      LOCAL_IMAGE_MAX_BYTES
    )
  })

  it("leaves an author-written span with no destination as plain text", async () => {
    const { container } = render(
      preview("<span data-codeg-local-image>important text</span>")
    )
    await waitFor(() =>
      expect(container.textContent).toContain("important text")
    )
    expect(screen.queryByRole("img")).not.toBeInTheDocument()
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it("never falls back to the active workspace when its own root is unknown", async () => {
    render(preview("![Unavailable](./preview.png)", null))
    expect(
      screen.getByRole("img", { name: "Unavailable" })
    ).not.toHaveAttribute("src")
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it("replaces a refused or undecodable image with its accessible alt text", async () => {
    mocks.read.mockRejectedValueOnce(new Error("symlink outside workspace"))
    const { rerender } = render(preview("![Missing](./missing.png)"))
    await waitFor(() =>
      expect(screen.queryByRole("status")).not.toBeInTheDocument()
    )
    expect(screen.getByRole("img", { name: "Missing" }).tagName).toBe("SPAN")
    rerender(preview("![Broken](./broken.png)"))
    await screen.findByRole("button", { name: "Broken" })
    fireEvent.error(screen.getByRole("img", { name: "Broken" }))
    expect(screen.getByRole("img", { name: "Broken" }).tagName).toBe("SPAN")
  })

  it("does not show the previous workspace's bytes while a new one loads", async () => {
    const { rerender } = render(preview("![Preview](./preview.png)", "/first"))
    await screen.findByRole("button", { name: "Preview" })
    fireEvent.click(screen.getByRole("button", { name: "Preview" }))
    expect(screen.getByRole("dialog")).toBeVisible()
    let finish!: (data: string) => void
    mocks.read.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        })
    )
    rerender(preview("![Preview](./preview.png)", "/second"))
    expect(
      screen.queryByRole("img", { name: "Preview" })
    ).not.toBeInTheDocument()
    expect(mocks.read).toHaveBeenLastCalledWith(
      "/second",
      "preview.png",
      LOCAL_IMAGE_MAX_BYTES
    )
    await act(async () => {
      finish(PNG)
    })
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(screen.getByRole("img", { name: "Preview" })).toHaveAttribute(
      "src",
      `data:image/png;base64,${PNG}`
    )
  })

  it("discards a read that completes after its source changed", async () => {
    let finishOld!: (data: string) => void
    mocks.read.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishOld = resolve
        })
    )
    const { rerender } = render(preview("![Old](./old.png)"))
    rerender(preview("![New](./replacement.png)"))
    await screen.findByRole("button", { name: "New" })
    await act(async () => {
      finishOld("b2xk")
    })
    expect(screen.getByRole("img", { name: "New" })).toHaveAttribute(
      "src",
      `data:image/png;base64,${PNG}`
    )
  })
})
