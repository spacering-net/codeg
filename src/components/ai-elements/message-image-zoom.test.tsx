import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({
  readWorkspaceFileBase64: vi.fn(),
  readFileBase64: vi.fn(),
}))
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("@/components/ai-elements/link-safety", () => ({
  useStreamdownLinkSafety: () => ({ enabled: false }),
  parseLocalFileTarget: () => null,
  openLinkWithSafety: vi.fn(),
}))

// The real parse/sanitize/harden pipeline: whether an image sits in a link is
// only known after harden has had its say.
import { MessageResponse } from "./message"

const SRC = "https://example.com/shot.png"

function imageOf(container: HTMLElement) {
  return container.querySelector<HTMLImageElement>(`img[src="${SRC}"]`)
}

describe("remote Markdown images open at full size", () => {
  it("opens a remote image's preview on click", async () => {
    const { container } = render(
      <MessageResponse>{`![Shot](${SRC})`}</MessageResponse>
    )
    await waitFor(() => expect(imageOf(container)).not.toBeNull())
    expect(screen.queryByRole("dialog")).toBeNull()
    fireEvent.click(imageOf(container)!)
    const dialog = await screen.findByRole("dialog")
    expect(dialog.querySelector(`img[src="${SRC}"]`)).not.toBeNull()
  })

  it("opens it from the keyboard too", async () => {
    const { container } = render(
      <MessageResponse>{`![Shot](${SRC})`}</MessageResponse>
    )
    await waitFor(() => expect(imageOf(container)).not.toBeNull())
    expect(imageOf(container)).toHaveAttribute("tabindex", "0")
    fireEvent.keyDown(imageOf(container)!, { key: "Enter" })
    expect(await screen.findByRole("dialog")).toBeVisible()
  })

  it.each([
    `[![Shot](${SRC})](https://example.com/gallery)`,
    `[![Shot][s]](https://example.com/gallery)\n\n[s]: ${SRC}`,
  ])("leaves a linked image's click to its link: %s", async (markdown) => {
    const { container } = render(<MessageResponse>{markdown}</MessageResponse>)
    await waitFor(() => expect(imageOf(container)).not.toBeNull())
    const image = imageOf(container)!
    expect(image).not.toHaveAttribute("tabindex")
    expect(image.closest("[data-streamdown='link']")).not.toBeNull()
    fireEvent.click(image)
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})
