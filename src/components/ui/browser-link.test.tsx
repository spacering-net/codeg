import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { openUrl } from "@/lib/platform"
import { BrowserLink } from "./browser-link"

// Partial mock: only the opener is stubbed, so anything else this module graph
// pulls from `@/lib/platform` later keeps its real implementation.
vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  openUrl: vi.fn(async () => {}),
}))

const URL = "https://example.com/docs"

beforeEach(() => {
  vi.mocked(openUrl).mockClear()
})

describe("BrowserLink", () => {
  it("stays a real link in the DOM", () => {
    // href/target/rel are what middle-click and "copy link address" read.
    render(<BrowserLink href={URL}>docs</BrowserLink>)
    const link = screen.getByRole("link", { name: "docs" })
    expect(link).toHaveAttribute("href", URL)
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveAttribute("rel", "noreferrer")
  })

  it("opens through the platform opener, not the webview", async () => {
    render(<BrowserLink href={URL}>docs</BrowserLink>)
    await userEvent.click(screen.getByRole("link", { name: "docs" }))
    expect(openUrl).toHaveBeenCalledWith(URL)
  })

  it("cancels the native navigation so web mode opens one tab, not two", async () => {
    const seen = vi.fn()
    // The listener sits on the document, where the click lands after React's
    // own handler has run — `defaultPrevented` there is the real verdict.
    document.addEventListener("click", seen)
    render(<BrowserLink href={URL}>docs</BrowserLink>)
    await userEvent.click(screen.getByRole("link", { name: "docs" }))
    document.removeEventListener("click", seen)
    expect(seen).toHaveBeenCalled()
    expect(seen.mock.calls[0][0].defaultPrevented).toBe(true)
  })

  it("runs the caller's onClick first and still opens", async () => {
    // The task board's case: swallow the click so the card underneath does not
    // also open its detail sheet.
    const onClick = vi.fn((e: React.MouseEvent) => e.stopPropagation())
    render(
      <BrowserLink href={URL} onClick={onClick}>
        docs
      </BrowserLink>
    )
    await userEvent.click(screen.getByRole("link", { name: "docs" }))
    expect(onClick).toHaveBeenCalled()
    expect(openUrl).toHaveBeenCalledWith(URL)
  })

  it("lets the caller's preventDefault veto the open", async () => {
    const onClick = vi.fn((e: React.MouseEvent) => e.preventDefault())
    render(
      <BrowserLink href={URL} onClick={onClick}>
        docs
      </BrowserLink>
    )
    await userEvent.click(screen.getByRole("link", { name: "docs" }))
    expect(onClick).toHaveBeenCalled()
    expect(openUrl).not.toHaveBeenCalled()
  })

  it("opens on a modified click too, where the native default is dead", async () => {
    render(<BrowserLink href={URL}>docs</BrowserLink>)
    await userEvent.keyboard("{Meta>}")
    await userEvent.click(screen.getByRole("link", { name: "docs" }))
    await userEvent.keyboard("{/Meta}")
    expect(openUrl).toHaveBeenCalledWith(URL)
  })

  it("keeps the class and title it is given", () => {
    render(
      <BrowserLink href={URL} className="truncate" title="tooltip">
        docs
      </BrowserLink>
    )
    const link = screen.getByRole("link", { name: "docs" })
    expect(link).toHaveClass("truncate")
    expect(link).toHaveAttribute("title", "tooltip")
  })
})
