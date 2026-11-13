import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ForgeImage, ForgeRemote } from "@/lib/types"

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  localRead: vi.fn(),
  absoluteRead: vi.fn(),
}))
vi.mock("@/lib/api", () => ({
  forgeReadImage: mocks.read,
  readWorkspaceFileBase64: mocks.localRead,
  readFileBase64: mocks.absoluteRead,
}))
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("@/components/ai-elements/link-safety", () => ({
  useStreamdownLinkSafety: () => ({ enabled: false }),
  parseLocalFileTarget: () => null,
}))
vi.mock("@/components/message/image-actions", () => ({
  ImageActions: ({ children }: { children: React.ReactNode }) => children,
  useImageActions: () => ({ canCopy: false, copy: vi.fn(), download: vi.fn() }),
}))

// Exercise the real parse/sanitize/harden pipeline; a mocked renderer would
// miss uploads turning into local-file markers and losing dimension attributes.
import { ForgeMarkdown, ForgeMarkdownProvider } from "./forge-markdown"
import { gitlabUploadPath } from "./remark-gitlab-images"

const IMAGE: ForgeImage = {
  mime_type: "image/png",
  url: "http://127.0.0.1:7000/api/forge_image/cached-image?cap=private",
}
const UPLOAD = "/uploads/b1f62467989935311a5735eff346a6c7/image.png"
const REMOTE: ForgeRemote = {
  provider: "gitlab",
  supported: true,
  server_host: "gitlab.test",
  owner_repo: "group/sub/project",
  remote_url: "git@gitlab.test:group/sub/project.git",
  web_origin: "https://gitlab.test/gitlab",
}

function preview(markdown: string, folderId = 7, remote = REMOTE) {
  return (
    <ForgeMarkdownProvider folderId={folderId} remote={remote}>
      <ForgeMarkdown>{markdown}</ForgeMarkdown>
    </ForgeMarkdownProvider>
  )
}

beforeEach(() => {
  mocks.read.mockReset().mockResolvedValue(IMAGE)
  mocks.localRead.mockReset()
  mocks.absoluteRead.mockReset()
})

describe("GitLab repository Markdown", () => {
  it("renders issue #6's upload and dimensions without reading a local file", async () => {
    const { container } = render(
      preview(`![image](${UPLOAD}){width=371 height=600}`)
    )
    const image = await screen.findByRole("img", { name: "image" })
    expect(image).toHaveAttribute("src", IMAGE.url)
    expect(image).toHaveAttribute("width", "371")
    expect(image).toHaveAttribute("height", "600")
    expect(image).toHaveClass("max-w-full", "h-auto")
    expect(container.textContent).not.toContain("{width=")
    expect(mocks.read).toHaveBeenCalledWith(7, UPLOAD)
    expect(mocks.localRead).not.toHaveBeenCalled()
    expect(mocks.absoluteRead).not.toHaveBeenCalled()
  })

  it.each([
    ["{width=200}", "200", null],
    ["{height=300}", null, "300"],
    ["{height=300 width=200}", "200", "300"],
  ])("supports dimensions %s", async (suffix, width, height) => {
    render(preview(`![shot](${UPLOAD})${suffix}`))
    const image = await screen.findByRole("img", { name: "shot" })
    expect(image.getAttribute("width")).toBe(width)
    expect(image.getAttribute("height")).toBe(height)
    expect(image).toHaveStyle({ height: width ? "auto" : `${height}px` })
    expect(screen.queryByText(suffix)).not.toBeInTheDocument()
  })

  it("supports reference images inside links and absolute project upload URLs", async () => {
    const url = `${REMOTE.web_origin}/${REMOTE.owner_repo}${UPLOAD}`
    const { container } = render(
      preview(`[![shot][s]](https://example.com/gallery)\n\n[s]: ${url}`)
    )
    const image = await screen.findByRole("img", { name: "shot" })
    expect(image).toHaveAttribute("src", IMAGE.url)
    expect(image.closest("[data-streamdown='link']")).toHaveAttribute(
      "title",
      "https://example.com/gallery"
    )
    expect(container.querySelector("button button")).toBeNull()
    expect(mocks.read).toHaveBeenCalledWith(7, UPLOAD)
  })

  it("applies dimensions to ordinary remote images without downloading them through an account", async () => {
    const { container } = render(
      preview("![remote](https://example.com/shot.png){width=200 height=300}")
    )
    const image = container.querySelector("img")
    expect(image).toHaveAttribute("src", "https://example.com/shot.png")
    expect(image).toHaveAttribute("width", "200")
    expect(image).toHaveAttribute("height", "300")
    expect(container.textContent).not.toContain("{width=")
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it("preserves code examples, escaped braces and unsupported attributes", async () => {
    const { container } = render(
      preview(
        `\`![inline](${UPLOAD}){width=1}\`\n\n` +
          `![escaped](${UPLOAD})\\{width=22}\n\n` +
          `![invalid](${UPLOAD}){width=-1}\n\n` +
          `![duplicate](${UPLOAD}){width=1 width=2}\n\n` +
          `![ordinary](${UPLOAD}){class=secret}`
      )
    )
    await screen.findByRole("img", { name: "escaped" })
    expect(container.textContent).toContain(`![inline](${UPLOAD}){width=1}`)
    expect(container.textContent).toContain("{width=22}")
    expect(container.textContent).toContain("{width=-1}")
    expect(container.textContent).toContain("{width=1 width=2}")
    expect(container.textContent).toContain("{class=secret}")
    expect(screen.getByRole("img", { name: "escaped" })).not.toHaveAttribute(
      "width"
    )
  })

  it("keeps GitHub and chat Markdown out of the GitLab upload reader", async () => {
    const { container } = render(
      preview(`![shot](${UPLOAD}){width=200}`, 7, {
        ...REMOTE,
        provider: "github",
      })
    )
    await waitFor(() => expect(container.textContent).toContain("shot"))
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.absoluteRead).not.toHaveBeenCalled()
    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).toContain("{width=200}")
  })

  it("shows accessible alt text when the download or browser decoding fails", async () => {
    mocks.read.mockRejectedValueOnce(new Error("denied"))
    const { rerender } = render(preview(`![denied](${UPLOAD})`))
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "denied" }).tagName).toBe("SPAN")
    )
    rerender(preview(`![broken](${UPLOAD.replace("image.png", "broken.png")})`))
    const image = await screen.findByRole("img", { name: "broken" })
    fireEvent.error(image)
    expect(screen.getByRole("img", { name: "broken" }).tagName).toBe("SPAN")
  })

  it("deduplicates simultaneous upload reads in a description and comment", async () => {
    render(
      <ForgeMarkdownProvider folderId={7} remote={REMOTE}>
        <ForgeMarkdown>{`![description](${UPLOAD})`}</ForgeMarkdown>
        <ForgeMarkdown>{`![comment](${UPLOAD})`}</ForgeMarkdown>
      </ForgeMarkdownProvider>
    )
    await screen.findByRole("img", { name: "description" })
    await screen.findByRole("img", { name: "comment" })
    expect(mocks.read).toHaveBeenCalledTimes(1)
  })

  it("reparses unchanged Markdown when the repository metadata arrives", async () => {
    const body = `![shot](${UPLOAD}){width=200}`
    const { container, rerender } = render(
      <ForgeMarkdownProvider folderId={7} remote={null}>
        <ForgeMarkdown>{body}</ForgeMarkdown>
      </ForgeMarkdownProvider>
    )
    expect(container.querySelector("img")).toBeNull()
    rerender(preview(body))
    expect(await screen.findByRole("img", { name: "shot" })).toHaveAttribute(
      "src",
      IMAGE.url
    )
    expect(container.textContent).not.toContain("{width=")
  })

  it("never shows the previous repository's bytes after a folder switch", async () => {
    let finish: (image: ForgeImage) => void = () => {}
    mocks.read.mockImplementationOnce(
      () =>
        new Promise<ForgeImage>((resolve) => {
          finish = resolve
        })
    )
    const { container, rerender } = render(preview(`![shot](${UPLOAD})`, 7))
    rerender(preview(`![shot](${UPLOAD})`, 8))
    await screen.findByRole("img", { name: "shot" })
    await act(async () => finish({ mime_type: "image/png", url: "OLD" }))
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      IMAGE.url
    )
    expect(mocks.read).toHaveBeenCalledWith(8, UPLOAD)
  })
})

describe("project upload coordinates", () => {
  const project = `${REMOTE.web_origin}/${REMOTE.owner_repo}`
  it.each([UPLOAD, UPLOAD.slice(1), `${project}${UPLOAD}`])(
    "resolves %s in the current project",
    (source) => {
      expect(gitlabUploadPath(source, project)).toBe(UPLOAD)
    }
  )
  it.each([
    `https://other.test${UPLOAD}`,
    `https://gitlab.test/gitlab/other/project${UPLOAD}`,
    `https://user:secret@gitlab.test/gitlab/group/sub/project${UPLOAD}`,
    `${UPLOAD}?private_token=secret`,
    "/etc/passwd",
    "file:///tmp/image.png",
    "data:image/png;base64,AAAA",
  ])("does not proxy %s with account credentials", (source) => {
    expect(gitlabUploadPath(source, project)).toBeNull()
  })
})
