import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import { resetHtmlPreviewCachesForTests } from "./html-code-preview"
import { JsonRenderScope } from "./json-render-pre"
import { MessageResponse } from "./message"

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}))

// Links route through link safety, which reads app settings; not under test.
vi.mock("@/components/ai-elements/link-safety", () => ({
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))

function reply(text: string, streaming = false, assistant = true) {
  const content = (
    <MessageResponse
      mode={streaming ? "streaming" : "static"}
      parseIncompleteMarkdown={streaming}
    >
      {text}
    </MessageResponse>
  )
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {assistant ? <JsonRenderScope>{content}</JsonRenderScope> : content}
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem("workspace:chat-html-rendering", "true")
  resetHtmlPreviewCachesForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function reportHeight(frame: HTMLElement, height: number) {
  act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source: (frame as HTMLIFrameElement).contentWindow,
        data: { type: "codeg-visualize:size", height },
      })
    )
  )
}

describe("rich HTML in assistant replies", () => {
  it("renders styled HTML between Markdown paragraphs without injecting it into the host", async () => {
    const html =
      '<style>.cards{display:grid;grid-template-columns:1fr 1fr}</style>\n<div class="cards"><div>A</div><div>B</div></div>'
    const { container } = render(
      reply(`Before **card**.\n\n${html}\n\nAfter card.`)
    )
    expect(screen.getByText("card")).toBeInTheDocument()
    expect(screen.getByText("After card.")).toBeInTheDocument()
    const frame = await screen.findByTitle("HTML preview")
    expect(frame.getAttribute("srcdoc")).toContain(
      "grid-template-columns:1fr 1fr"
    )
    expect(frame.getAttribute("srcdoc")).toContain('class="cards"')
    expect(container.querySelector(".cards")).toBeNull()
  })

  it("shows HTML fences directly while preserving their source view", async () => {
    render(reply("```html\n<div>Card</div>\n```"))
    expect(await screen.findByTitle("HTML preview")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Code" }))
    expect(screen.queryByTitle("HTML preview")).toBeNull()
    expect(screen.getByText("<div>Card</div>")).toBeInTheDocument()
    expect(screen.queryByText("codeg-html")).toBeNull()
  })

  it("leaves HTML fences as code when the setting is disabled", () => {
    localStorage.setItem("workspace:chat-html-rendering", "false")
    render(reply("```html\n<div>Card</div>\n```"))
    expect(screen.queryByTitle("HTML preview")).toBeNull()
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull()
  })

  it("does not enable rich HTML for user messages", () => {
    render(reply("```html\n<div>User content</div>\n```", false, false))
    expect(screen.queryByTitle("HTML preview")).toBeNull()
  })

  it("waits for a complete fragment and keeps its frame when later prose arrives", async () => {
    const { rerender } = render(
      reply('<div style="display:flex"><p>First</p>', true)
    )
    expect(screen.queryByTitle("HTML preview")).toBeNull()
    expect(screen.getByRole("status")).toBeInTheDocument()
    const complete = '<div style="display:flex"><p>First</p></div>'
    // Until the next block shows, another root could still join it.
    rerender(reply(complete, true))
    expect(screen.queryByTitle("HTML preview")).toBeNull()
    rerender(reply(complete + "\n\nFollowing", true))
    const frame = await screen.findByTitle("HTML preview")
    const document = frame.getAttribute("srcdoc")
    rerender(reply(complete + "\n\nFollowing **prose**.", true))
    expect(screen.getByTitle("HTML preview")).toBe(frame)
    expect(frame.getAttribute("srcdoc")).toBe(document)
  })

  it("brings a preview back as it was when the reply stops streaming", async () => {
    const text = '<div style="display:flex"><p>First</p></div>\n\nAfter.'
    const { rerender } = render(reply(text, true))
    const frame = await screen.findByTitle("HTML preview")
    const document = frame.getAttribute("srcdoc")
    reportHeight(frame, 240)
    fireEvent.click(screen.getByRole("button", { name: "Code" }))
    fireEvent.click(screen.getByRole("button", { name: "Preview" }))
    // A finished reply is a new tree: the preview mounts again, at once and
    // at the height it measured — no "Generating", no default height.
    rerender(reply(text))
    expect(screen.queryByRole("status")).toBeNull()
    const finished = screen.getByTitle("HTML preview")
    expect(finished.getAttribute("srcdoc")).toBe(document)
    expect(finished.style.height).toBe("240px")
  })

  it("keeps the reader's choice of view when the reply stops streaming", async () => {
    const text = "<div>Card</div>\n\nAfter."
    const { rerender } = render(reply(text, true))
    await screen.findByTitle("HTML preview")
    fireEvent.click(screen.getByRole("button", { name: "Code" }))
    rerender(reply(text))
    expect(screen.queryByTitle("HTML preview")).toBeNull()
    expect(screen.getByRole("button", { name: "Code" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
  })

  it("draws a finished reply the way it does without the setting", async () => {
    const markdown = [
      "مرحبا بكم في المشروع.",
      "",
      "Hello there.",
      "",
      "- عنصر أول",
      "- عنصر ثان",
      "",
      "مرحبا `code here` بكم",
      "",
      "See [the docs][1].",
      "",
      "[1]: https://example.com/docs",
    ].join("\n")
    for (const enabled of ["false", "true"]) {
      localStorage.setItem("workspace:chat-html-rendering", enabled)
      const { container, unmount } = render(reply(markdown))
      const dirOf = (start: string) =>
        Array.from(container.querySelectorAll("p"))
          .find((p) => p.textContent?.startsWith(start))
          ?.getAttribute("dir")
      expect(dirOf("مرحبا بكم")).toBe("rtl")
      expect(dirOf("Hello")).toBe("ltr")
      expect(container.querySelector("li")).toHaveAttribute("dir", "rtl")
      expect(screen.getByText("code here")).toHaveAttribute("dir", "ltr")
      expect(dirOf("See")).toBe("ltr")
      expect(
        Array.from(container.querySelectorAll("p")).some(
          (p) => p.textContent === "See the docs."
        )
      ).toBe(true)
      unmount()
    }
  })

  it("leaves Markdown wrapped in HTML tags to Markdown", () => {
    const { container } = render(
      reply(
        "Intro.\n\n<details>\n<summary>More</summary>\n\n- item **one**\n- item two\n\n</details>\n\nAfter."
      )
    )
    expect(screen.queryByTitle("HTML preview")).toBeNull()
    expect(container.querySelector("details summary")).toHaveTextContent("More")
    const item = Array.from(container.querySelectorAll("li")).find((li) =>
      li.textContent?.includes("one")
    )
    // Rendered as Markdown: bold, not literal asterisks.
    expect(item?.textContent).toBe("item one")
  })

  it("previews where crypto.randomUUID is missing (plain-HTTP origins)", async () => {
    const { getRandomValues } = globalThis.crypto
    vi.stubGlobal("crypto", {
      getRandomValues: getRandomValues.bind(globalThis.crypto),
    })
    render(reply("<div>Card</div>"))
    const frame = await screen.findByTitle("HTML preview")
    expect(frame.getAttribute("srcdoc")).toMatch(/script-src 'nonce-[\w-]+'/)
  })

  it("shows an agent's own codeg-html-pending fence as code once the reply is done", () => {
    render(reply("```codeg-html-pending\n<div>x</div>\n```\n\nDone."))
    expect(screen.queryByRole("status")).toBeNull()
    expect(screen.getByText("<div>x</div>")).toBeInTheDocument()
  })

  it("does not activate incomplete HTML fences during streaming", () => {
    render(reply("```html\n<div>Complete markup</div>", true))
    expect(screen.queryByTitle("HTML preview")).toBeNull()
    expect(screen.getByRole("status")).toBeInTheDocument()
  })

  it("executes only the host height reporter, never model scripts", async () => {
    render(
      reply(
        '<div onclick="alert(1)"><script>window.MODEL_SCRIPT=1</script><style>.x{color:red}</style><p>Safe</p></div>'
      )
    )
    const frame = await screen.findByTitle("HTML preview")
    const doc = frame.getAttribute("srcdoc")!
    expect(doc).not.toContain("MODEL_SCRIPT")
    expect(doc).not.toContain("onclick")
    expect(doc).toContain("script-src 'nonce-")
    expect(doc).not.toContain("'unsafe-eval'")
    expect(frame).toHaveAttribute("sandbox", "allow-scripts")
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer")
  })

  it("ignores spoofed height messages and uses reports from its own frame", async () => {
    render(reply("<div>Card</div>"))
    const frame = (await screen.findByTitle(
      "HTML preview"
    )) as HTMLIFrameElement
    const initialHeight = frame.style.height
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          data: { type: "codeg-visualize:size", height: 1000 },
        })
      )
    )
    expect(frame.style.height).toBe(initialHeight)
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          data: { type: "codeg-visualize:size", height: 240 },
        })
      )
    )
    expect(frame.style.height).toBe("240px")
  })
})
