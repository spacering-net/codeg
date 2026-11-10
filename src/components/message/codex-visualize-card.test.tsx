import { type ReactNode } from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  readFileBase64: vi.fn(),
  readWorkspaceFileBase64: vi.fn(),
  getHomeDirectory: vi.fn(),
  listDirectoryEntries: vi.fn(),
}))

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    readFileBase64: mocks.readFileBase64,
    readWorkspaceFileBase64: mocks.readWorkspaceFileBase64,
    getHomeDirectory: mocks.getHomeDirectory,
    listDirectoryEntries: mocks.listDirectoryEntries,
  }
})

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}))

vi.mock("@/components/ai-elements/link-safety", () => ({
  FilePathLink: ({
    children,
    filePath,
  }: {
    children: ReactNode
    filePath: string
  }) => (
    <span data-testid="open-file" data-file-path={filePath}>
      {children}
    </span>
  ),
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))

vi.mock("@/components/ai-elements/code-block", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
}))

vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: string }) => (
    <div data-testid="markdown">{children}</div>
  ),
}))

import { MarkdownImageProvider } from "@/components/ai-elements/markdown-local-image"
import { ContentPartsRenderer } from "./content-parts-renderer"
import {
  buildVisualizeDocument,
  resetCodexVisualizeAssetsForTests,
} from "./codex-visualize-card"
import enMessages from "@/i18n/messages/en.json"

const toBase64 = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))

const MARKER = '\uE200visualize\uE202{"path":"/v/chart.html"}\uE201'

/** A reply inside a transcript whose working directory is `root`. */
function Transcript({ text, root }: { text: string; root: string | null }) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MarkdownImageProvider rootPath={root}>
        <ContentPartsRenderer
          parts={[{ type: "text", text }]}
          role="assistant"
        />
      </MarkdownImageProvider>
    </NextIntlClientProvider>
  )
}

function renderText(text: string, root: string | null = null) {
  return render(<Transcript text={text} root={root} />)
}

beforeEach(() => {
  resetCodexVisualizeAssetsForTests()
  mocks.readFileBase64.mockReset()
  mocks.readWorkspaceFileBase64.mockReset()
  mocks.getHomeDirectory.mockReset().mockResolvedValue("/home/u")
  mocks.listDirectoryEntries.mockReset().mockRejectedValue(new Error("nope"))
})

describe("CodexVisualizeCard via ContentPartsRenderer", () => {
  it("renders prose without a marker as plain Markdown", () => {
    renderText("Just prose.")
    expect(screen.getByTestId("markdown")).toHaveTextContent("Just prose.")
    expect(screen.queryByTestId("codex-visualize-card")).toBeNull()
  })

  it("swaps the marker for a sandboxed frame showing the fragment", async () => {
    mocks.readFileBase64.mockResolvedValue(
      toBase64('<div class="card">Hello <b>viz</b></div>')
    )
    renderText(`Here you go.\n\n${MARKER}\n\nEnjoy.`)

    const card = await screen.findByTestId("codex-visualize-card")
    expect(card).toHaveAttribute("data-mode", "normal")
    const frame = await waitFor(() => {
      const el = card.querySelector("iframe")
      if (!el) throw new Error("no iframe yet")
      return el
    })
    expect(frame).toHaveAttribute("sandbox", "allow-scripts")
    expect(frame.getAttribute("srcdoc")).toContain('<div class="card">Hello')
    expect(frame.getAttribute("srcdoc")).toContain("Content-Security-Policy")
    // The fragment is read from the absolute path in the marker.
    expect(mocks.readFileBase64).toHaveBeenCalledWith(
      "/v/chart.html",
      expect.any(Number)
    )
    // The prose around the marker survives, minus the marker itself.
    const md = screen.getAllByTestId("markdown").map((n) => n.textContent)
    expect(md.join("|")).toContain("Here you go.")
    expect(md.join("|")).toContain("Enjoy.")
    expect(md.join("|")).not.toContain("visualize{")
  })

  it("shows an error instead of a frame when the file cannot be read", async () => {
    mocks.readFileBase64.mockRejectedValue(new Error("File does not exist"))
    renderText(MARKER)
    await screen.findByText("Could not load the visualization")
    expect(screen.getByText("File does not exist")).toBeInTheDocument()
    expect(document.querySelector("iframe")).toBeNull()
  })

  it("marks wide-mode visuals", async () => {
    mocks.readFileBase64.mockResolvedValue(toBase64("<p>w</p>"))
    renderText(
      '\uE200visualize\uE202{"path":"/v/app.html","mode":"wide"}\uE201'
    )
    const card = await screen.findByTestId("codex-visualize-card")
    expect(card).toHaveAttribute("data-mode", "wide")
    expect(screen.getByText("Wide")).toBeInTheDocument()
  })
})

describe("HTML files a reply mentions", () => {
  const frameOf = async (card: HTMLElement) =>
    waitFor(() => {
      const el = card.querySelector("iframe")
      if (!el) throw new Error("no iframe yet")
      return el
    })

  it("offers a collapsed Preview row and expands it on demand", async () => {
    mocks.readFileBase64.mockResolvedValue(
      toBase64(
        "<!doctype html><html><head><title>Fitness Report</title></head><body><h1>Week 38</h1></body></html>"
      )
    )
    renderText("I wrote the report to `/Users/u/fit/fitness-report.html`.")

    const row = await screen.findByTestId("html-file-preview")
    expect(row).toHaveTextContent("fitness-report.html")
    expect(mocks.readFileBase64).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: /Preview/ }))
    const card = await screen.findByTestId("codex-visualize-card")
    const frame = await frameOf(card)
    const doc = frame.getAttribute("srcdoc") ?? ""
    // A complete document keeps its own markup and titles the card with its
    // <title> — and, like codeg's file preview, runs no script (and gets no
    // network) until the user enables scripts for it.
    expect(doc).toContain("<h1>Week 38</h1>")
    expect(doc).toContain("script-src 'none'")
    expect(doc).not.toContain("codeg-visualize:size")
    expect(frame).toHaveAttribute("sandbox", "")
    expect(frame.style.height).toBe("480px")
    await screen.findByText("Fitness Report")
    const scriptsToggle = screen.getByRole("button", { name: /Enable scripts/ })
    expect(scriptsToggle).toHaveAttribute("aria-pressed", "false")
    expect(scriptsToggle).toHaveAttribute(
      "title",
      enMessages.Folder.fileWorkspacePanel.htmlPreviewTrustHint
    )

    fireEvent.click(scriptsToggle)
    const trusted = await waitFor(() => {
      const el = card.querySelector("iframe")
      if (el?.getAttribute("sandbox") !== "allow-scripts")
        throw new Error("still static")
      return el
    })
    const trustedDoc = trusted.getAttribute("srcdoc") ?? ""
    expect(trustedDoc).toContain("connect-src https: http:")
    expect(trustedDoc).toContain("codeg-visualize:size")
    expect(screen.getByRole("button", { name: /Scripts on/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    )

    fireEvent.click(screen.getByRole("button", { name: "Hide preview" }))
    expect(await screen.findByTestId("html-file-preview")).toBeInTheDocument()
  })

  it("resolves relative mentions against the transcript's folder", async () => {
    mocks.readFileBase64.mockResolvedValue(toBase64("<p>ok</p>"))
    renderText("Open [the page](site/index.html) to check.", "/repo")
    fireEvent.click(await screen.findByRole("button", { name: /Preview/ }))
    await screen.findByTestId("codex-visualize-card")
    await waitFor(() =>
      expect(mocks.readFileBase64).toHaveBeenCalledWith(
        "/repo/site/index.html",
        expect.any(Number)
      )
    )
  })

  it("drops relative mentions when there is no folder to resolve them", () => {
    renderText("See `index.html`.")
    expect(screen.queryByTestId("html-file-preview")).toBeNull()
  })

  it("expands ~/ paths against the home directory", async () => {
    mocks.readFileBase64.mockResolvedValue(toBase64("<p>ok</p>"))
    renderText("Saved to ~/reports/fitness.html")
    fireEvent.click(await screen.findByRole("button", { name: /Preview/ }))
    await waitFor(() =>
      expect(mocks.readFileBase64).toHaveBeenCalledWith(
        "/home/u/reports/fitness.html",
        expect.any(Number)
      )
    )
  })

  it("renders a Hermes ::preview directive expanded in place", async () => {
    mocks.readFileBase64.mockResolvedValue(toBase64("<p>hermes</p>"))
    renderText(
      'Here:\n::preview{file="/h/out/report.html"}\nMEDIA:/h/out/report.html'
    )
    const card = await screen.findByTestId("codex-visualize-card")
    expect((await frameOf(card)).getAttribute("srcdoc")).toContain(
      "<p>hermes</p>"
    )
    // The MEDIA: line names the same file, so no second preview row.
    expect(screen.queryByTestId("html-file-preview")).toBeNull()
    expect(
      screen
        .getAllByTestId("markdown")
        .map((n) => n.textContent)
        .join("")
    ).not.toContain("preview{")
  })

  it("resolves a relative Hermes directive against the transcript's folder", async () => {
    // Hermes' own prompt teaches `::preview{file="path.html"}`, relative to
    // the session's working directory.
    mocks.readFileBase64.mockResolvedValue(toBase64("<p>widget</p>"))
    renderText('Here:\n::preview{file="out/chart.html"}', "/repo")
    await screen.findByTestId("codex-visualize-card")
    await waitFor(() =>
      expect(mocks.readFileBase64).toHaveBeenCalledWith(
        "/repo/out/chart.html",
        expect.any(Number)
      )
    )
  })

  it("does not read a relative directive when there is no folder", async () => {
    renderText('::preview{file="chart.html"}')
    await screen.findByText("Could not load the visualization")
    expect(
      screen.getByText(enMessages.Folder.chat.linkSafety.errorNoWorkspace)
    ).toBeInTheDocument()
    expect(mocks.readFileBase64).not.toHaveBeenCalled()
    // Nor offer to open it: the opener would resolve the bare name against
    // whatever folder happens to be active.
    expect(screen.queryByTestId("open-file")).toBeNull()
  })

  it("opens the transcript's file, even when it cannot be previewed", async () => {
    mocks.readFileBase64.mockRejectedValue(new Error("File does not exist"))
    renderText('::preview{file="out/report.html"}', "/repo")
    expect(screen.getByTestId("open-file")).toHaveAttribute(
      "data-file-path",
      "/repo/out/report.html"
    )
    await screen.findByText("File does not exist")
    expect(screen.getByTestId("open-file")).toHaveAttribute(
      "data-file-path",
      "/repo/out/report.html"
    )
  })

  it("does not carry a scripts choice over to another folder's file", async () => {
    mocks.readFileBase64.mockResolvedValue(
      toBase64("<!doctype html><html><body><p>page</p></body></html>")
    )
    const text = '::preview{file="report.html"}'
    const { rerender } = renderText(text, "/trusted")
    const card = await screen.findByTestId("codex-visualize-card")
    const sandboxOf = () =>
      card.querySelector("iframe")?.getAttribute("sandbox")
    await waitFor(() => expect(sandboxOf()).toBe(""))
    fireEvent.click(screen.getByRole("button", { name: /Enable scripts/ }))
    await waitFor(() => expect(sandboxOf()).toBe("allow-scripts"))

    // Same name, same card, another transcript root: another file, which
    // starts without scripts again.
    rerender(<Transcript text={text} root="/untrusted" />)
    await waitFor(() =>
      expect(mocks.readFileBase64).toHaveBeenLastCalledWith(
        "/untrusted/report.html",
        expect.any(Number)
      )
    )
    await waitFor(() => expect(sandboxOf()).toBe(""))
    expect(card.querySelector("iframe")?.getAttribute("srcdoc")).toContain(
      "script-src 'none'"
    )
    expect(
      screen.getByRole("button", { name: /Enable scripts/ })
    ).toHaveAttribute("aria-pressed", "false")
  })
})

describe("frame sizing", () => {
  const sizeMessage = (frame: HTMLIFrameElement, height: number) =>
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "codeg-visualize:size", height },
        source: frame.contentWindow,
      })
    )

  it("follows the reported height, down as well as up", async () => {
    mocks.readFileBase64.mockResolvedValue(toBase64("<p>chart</p>"))
    renderText(MARKER)
    const card = await screen.findByTestId("codex-visualize-card")
    const frame = await waitFor(() => {
      const el = card.querySelector("iframe")
      if (!el) throw new Error("no iframe yet")
      return el
    })
    expect(frame.style.height).toBe("320px")

    act(() => sizeMessage(frame, 150))
    expect(frame.style.height).toBe("150px")

    // Taller than the collapsed cap: capped until "Show all".
    act(() => sizeMessage(frame, 5000))
    expect(frame.style.height).toBe("640px")
    fireEvent.click(screen.getByRole("button", { name: "Show all" }))
    expect(frame.style.height).toBe("5000px")

    // A runaway report stops at the backstop.
    act(() => sizeMessage(frame, 1e7))
    expect(frame.style.height).toBe("12000px")

    // Reports from anything but this card's frame are ignored.
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "codeg-visualize:size", height: 200 },
          source: window,
        })
      )
    )
    expect(frame.style.height).toBe("12000px")
  })
})

describe("buildVisualizeDocument", () => {
  const assets = { css: ":root{--x:1}", kit: null, calendar: null }

  it("wraps a fragment in a themed, CSP-protected document", () => {
    const doc = buildVisualizeDocument({
      fragment: "<p>hi</p>",
      assets,
      title: "A <b>",
      dark: true,
      themeOverrides: ":root{--background:red}",
    })
    expect(doc).toContain('style="color-scheme:dark"')
    expect(doc).toContain("<title>A &lt;b&gt;</title>")
    expect(doc).toContain(":root{--x:1}")
    expect(doc).toContain(":root{--background:red}")
    expect(doc).toContain("<p>hi</p>")
    expect(doc).toMatch(/Content-Security-Policy.*default-src 'none'/)
    // The frame paints no page background of its own, so the card's surface
    // (and the workspace background behind it) shows through — on `:root`,
    // which the skill's own `:root{…!important}` background would otherwise
    // outrank.
    expect(doc).toContain(":root,body{background:transparent !important")
    expect(doc).toContain("html>body{padding:1rem 1.25rem}")
    // In-page links stay in the frame instead of loading codeg into it.
    expect(doc).toContain('<base href="about:srcdoc">')
    expect(doc).toContain("base-uri about:")
  })

  it("gives fragments the window.openai state API before they run", () => {
    const doc = buildVisualizeDocument({
      fragment: "<script>draw(window.openai.widgetState)</script>",
      assets,
      title: "t",
      dark: false,
      themeOverrides: "",
    })
    const stub = doc.indexOf("window.openai=openai")
    expect(stub).toBeGreaterThan(-1)
    expect(stub).toBeLessThan(doc.indexOf("draw(window.openai.widgetState)"))
    expect(doc).toContain('theme:"light"')
  })

  it("puts the fragment into the plugin kit's slot when one is available", () => {
    const doc = buildVisualizeDocument({
      fragment: "<p>hi</p>",
      assets: {
        css: "",
        kit: "<!--__INLINE_VISUALIZATION_FRAGMENT__--><script>tooltips()</script>",
        calendar: "registerCalendar()",
      },
      title: "t",
      dark: false,
      themeOverrides: "",
    })
    expect(doc).toContain("<p>hi</p><script>tooltips()</script>")
    // calendar.js is only injected for fragments that use <viz-calendar>.
    expect(doc).not.toContain("registerCalendar()")
  })

  it("injects the calendar runtime for fragments that use it", () => {
    const doc = buildVisualizeDocument({
      fragment: "<viz-calendar></viz-calendar>",
      assets: { css: "", kit: null, calendar: "registerCalendar()" },
      title: "t",
      dark: false,
      themeOverrides: "",
    })
    expect(doc).toContain("<script>registerCalendar()</script><viz-calendar>")
  })
})
