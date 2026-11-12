import { act, fireEvent, render, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { buildChatHtmlDocument } from "@/lib/chat-html-document"
import {
  HtmlCodePreview,
  resetHtmlPreviewCachesForTests,
} from "./html-code-preview"

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}))
vi.mock("@/lib/chat-html-document", () => ({
  buildChatHtmlDocument: vi.fn(async (source: string) => `<p>${source}</p>`),
}))

const build = vi.mocked(buildChatHtmlDocument)
const preview = (source: string, key?: string) => (
  <HtmlCodePreview key={key} source={source}>
    <pre>code content</pre>
  </HtmlCodePreview>
)

// A closed preview trims the cache once its commit is over.
async function close(view: { unmount: () => void }) {
  view.unmount()
  await act(async () => {})
}

beforeEach(() => {
  resetHtmlPreviewCachesForTests()
  build.mockClear()
})

describe("HTML preview cache retention", () => {
  it("trims entries when the last owners of more than 32 previews close", async () => {
    const sources = Array.from({ length: 40 }, (_, i) => `preview ${i}`)
    const mounted = render(<>{sources.map((s) => preview(s, s))}</>)
    await waitFor(() =>
      expect(mounted.container.querySelectorAll("iframe")).toHaveLength(40)
    )
    await close(mounted)

    const reopened = render(preview(sources[0]))
    await waitFor(() =>
      expect(reopened.container.querySelector("iframe")).not.toBeNull()
    )
    expect(build).toHaveBeenCalledTimes(41)
  })

  it("does not retain an oversized document after its view closes", async () => {
    const source = "x".repeat(3 * 1024 * 1024)
    const mounted = render(preview(source))
    await waitFor(() =>
      expect(mounted.container.querySelector("iframe")).not.toBeNull()
    )
    await close(mounted)

    const reopened = render(preview(source))
    await waitFor(() =>
      expect(reopened.container.querySelector("iframe")).not.toBeNull()
    )
    expect(build).toHaveBeenCalledTimes(2)
  })

  it("bounds the combined size of otherwise cacheable documents", async () => {
    const sources = Array.from(
      { length: 8 },
      (_, i) => `${i}${"x".repeat(256 * 1024)}`
    )
    const mounted = render(<>{sources.map((s, i) => preview(s, String(i)))}</>)
    await waitFor(() =>
      expect(mounted.container.querySelectorAll("iframe")).toHaveLength(8)
    )
    await close(mounted)

    const reopened = render(preview(sources[0]))
    await waitFor(() =>
      expect(reopened.container.querySelector("iframe")).not.toBeNull()
    )
    expect(build).toHaveBeenCalledTimes(9)
  })

  it("does not keep a large source alive merely to remember its view choice", async () => {
    const source = "x".repeat(1024 * 1024)
    const mounted = render(preview(source))
    await waitFor(() =>
      expect(mounted.container.querySelector("iframe")).not.toBeNull()
    )
    fireEvent.click(mounted.getByRole("button", { name: "code" }))
    await close(mounted)

    const reopened = render(preview(source))
    await waitFor(() =>
      expect(reopened.container.querySelector("iframe")).not.toBeNull()
    )
  })

  it("keeps a shared active document pinned until its final owner closes", async () => {
    const source = "shared" + "x".repeat(3 * 1024 * 1024)
    const first = render(preview(source))
    await waitFor(() =>
      expect(first.container.querySelector("iframe")).not.toBeNull()
    )
    const second = render(preview(source))
    expect(second.container.querySelector("iframe")).not.toBeNull()
    await close(first)
    const third = render(preview(source))
    expect(third.container.querySelector("iframe")).not.toBeNull()
    expect(build).toHaveBeenCalledTimes(1)
    second.unmount()
    third.unmount()
  })

  it("keeps an over-budget document across a remount in the same commit", async () => {
    // Streamdown draws a finished reply as a new tree: the old preview
    // unmounts and the new one mounts in one commit, and must not rebuild.
    const source = "remount" + "x".repeat(3 * 1024 * 1024)
    const mounted = render(preview(source, "streaming"))
    await waitFor(() =>
      expect(mounted.container.querySelector("iframe")).not.toBeNull()
    )
    mounted.rerender(preview(source, "finished"))
    await act(async () => {})
    expect(mounted.container.querySelector("iframe")).not.toBeNull()
    expect(build).toHaveBeenCalledTimes(1)
    mounted.unmount()
  })

  it("keeps on-screen documents beyond the entry limit across a remount", async () => {
    const sources = Array.from({ length: 40 }, (_, i) => `on screen ${i}`)
    const tree = (last: string) => (
      <>
        {sources.map((s, i) => preview(s, i === sources.length - 1 ? last : s))}
      </>
    )
    const mounted = render(tree("streaming"))
    await waitFor(() =>
      expect(mounted.container.querySelectorAll("iframe")).toHaveLength(40)
    )
    mounted.rerender(tree("finished"))
    await act(async () => {})
    expect(mounted.container.querySelectorAll("iframe")).toHaveLength(40)
    expect(build).toHaveBeenCalledTimes(40)
    mounted.unmount()
  })

  it("applies the byte budget to a build that finishes after unmount", async () => {
    const source = "late" + "x".repeat(3 * 1024 * 1024)
    let finish!: (doc: string) => void
    build.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const mounted = render(preview(source))
    mounted.unmount()
    await act(async () => finish(`<p>${source}</p>`))

    const reopened = render(preview(source))
    await waitFor(() =>
      expect(reopened.container.querySelector("iframe")).not.toBeNull()
    )
    expect(build).toHaveBeenCalledTimes(2)
  })
})
