import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { ComponentType, ReactNode } from "react"
import { beforeEach, describe, expect, it } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import { resetHtmlPreviewCachesForTests } from "./html-code-preview"
import { messageBlockComponents, JsonRenderScope } from "./json-render-pre"
import { MessageResponse } from "./message"

const Pre = messageBlockComponents.pre as ComponentType<{
  children?: ReactNode
}>

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem("workspace:chat-html-rendering", "true")
  resetHtmlPreviewCachesForTests()
})

function reply(source: string, language = "html") {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <JsonRenderScope>
        <Pre>
          <code className={`language-${language}`}>{source}</code>
        </Pre>
      </JsonRenderScope>
    </NextIntlClientProvider>
  )
}

describe("HTML code preview", () => {
  it("offers preview for an HTML fence rendered by Streamdown", async () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <JsonRenderScope>
          <MessageResponse>{"```html\n<h1>Hello</h1>\n```"}</MessageResponse>
        </JsonRenderScope>
      </NextIntlClientProvider>
    )
    expect(
      (await screen.findByTitle("HTML preview")).getAttribute("srcdoc")
    ).toContain("<h1>Hello</h1>")
  })

  it("shows preview by default and unmounts the frame when returning to code", async () => {
    const { container } = render(reply("<h1>Hello</h1>"))
    const frame = await screen.findByTitle("HTML preview")
    expect(frame).toHaveAttribute("sandbox", "allow-scripts")
    expect(frame.getAttribute("srcdoc")).toContain("<h1>Hello</h1>")
    expect(frame.getAttribute("srcdoc")).toContain("Content-Security-Policy")
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer")
    fireEvent.click(screen.getByRole("button", { name: "Code" }))
    expect(container.querySelector("iframe")).toBeNull()
    expect(screen.getByText("<h1>Hello</h1>")).toBeInTheDocument()
  })

  it("updates the open preview when its source changes", async () => {
    const { rerender } = render(reply("<p>First</p>"))
    await screen.findByTitle("HTML preview")
    rerender(reply("<p>Second</p>"))
    await waitFor(() =>
      expect(
        screen.getByTitle("HTML preview").getAttribute("srcdoc")
      ).toContain("<p>Second</p>")
    )
  })

  it("leaves non-HTML fences unchanged", () => {
    render(reply("const x = 1", "javascript"))
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull()
    expect(screen.getByText("const x = 1")).toHaveAttribute(
      "data-block",
      "true"
    )
  })

  it("does not offer preview outside assistant replies", () => {
    render(
      <Pre>
        <code className="language-html">{"<p>User content</p>"}</code>
      </Pre>
    )
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull()
  })

  it.each(["HTML", "htm"])("supports the %s language label", (language) => {
    render(reply("<p>Hello</p>", language))
    expect(screen.getByRole("button", { name: "Preview" })).toBeInTheDocument()
  })

  it("keeps the view switch clear of the code block's own buttons", async () => {
    render(reply("<h1>Hello</h1>"))
    await screen.findByTitle("HTML preview")
    const toolbar = screen.getByRole("button", { name: "Code" }).parentElement
    // Over the frame, its corner is free.
    expect(toolbar).toHaveClass("end-1")
    fireEvent.click(screen.getByRole("button", { name: "Code" }))
    // Over code, Streamdown's copy and download buttons hold that corner.
    expect(toolbar).toHaveClass("end-18")
    expect(toolbar).not.toHaveClass("end-1")
  })

  it("keeps showing a preview it mounted from the cache after the cache moves on", async () => {
    const first = render(reply("<p>Kept</p>"))
    await screen.findByTitle("HTML preview")
    first.unmount()
    // Mounted again from the cache, as when a reply stops streaming.
    render(reply("<p>Kept</p>"))
    const frame = screen.getByTitle("HTML preview") as HTMLIFrameElement
    // Enough other previews to push its entry out of the cache.
    for (let i = 0; i < 40; i++) {
      const other = render(reply(`<p>Other ${i}</p>`))
      await waitFor(() =>
        expect(other.container.querySelector("iframe")).not.toBeNull()
      )
      other.unmount()
    }
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          data: { type: "codeg-visualize:size", height: 200 },
        })
      )
    )
    expect(screen.queryByRole("status")).toBeNull()
    expect(screen.getByTitle("HTML preview").getAttribute("srcdoc")).toContain(
      "<p>Kept</p>"
    )
  })
})
