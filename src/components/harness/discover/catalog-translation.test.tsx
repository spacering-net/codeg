import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import zh from "@/i18n/messages/zh-CN.json"
import type { HarnessItemSummary } from "@/lib/harness/types"
import {
  CatalogTranslationControls,
  CatalogTranslationProvider,
  TranslatedCatalogReadme,
} from "./catalog-translation"
import { DiscoverCard } from "./discover-card"
import { ReadmeContent, readmeProse } from "./readme-content"

const item: HarnessItemSummary = {
  id: "test-id",
  ref: "publisher/sample",
  name: "sample",
  kind: "skill",
  status: "public",
  title: { en: "Browser checks" },
  summary: { en: "Check the browser before installing." },
  publisher: {
    handle: "publisher",
    name: "Publisher",
    kind: "github",
    verified: false,
    unclaimed: true,
    avatar: null,
  },
  tags: [],
  runtime: "none",
  risk: "low",
  reviewed: false,
  featured: false,
  source: "github",
  repoStars: 0,
  stars: 0,
  installs: 0,
  latest: {
    revision: 1,
    version: "1.0.0",
    publishedAt: "2026-01-01T00:00:00Z",
  },
}

const messages = zh.Harness.discover.translation

function view(children: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="zh-CN" messages={zh}>
      <CatalogTranslationProvider>
        <CatalogTranslationControls />
        {children}
      </CatalogTranslationProvider>
    </NextIntlClientProvider>
  )
}

beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

describe("catalog browsing translation", () => {
  it("makes no request until enabled, translates before install, and keeps actions original", async () => {
    const fetcher = vi.fn(async (url: string) => {
      const text = new URL(url).searchParams.get("q")
      return {
        ok: true,
        json: async () => [
          [[text === "Browser checks" ? "浏览器检查" : "安装前检查浏览器。"]],
        ],
      }
    })
    vi.stubGlobal("fetch", fetcher)
    const original = JSON.stringify(item)
    const open = vi.fn()
    view(<DiscoverCard item={item} onOpen={open} />)
    expect(
      screen.getByRole("button", { name: "Browser checks" })
    ).toBeInTheDocument()
    expect(fetcher).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: messages.translate }))
    await screen.findByRole("button", { name: "浏览器检查" })
    expect(screen.getByText("安装前检查浏览器。")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "浏览器检查" }))
    expect(open).toHaveBeenCalledWith(item)
    expect(JSON.stringify(item)).toBe(original)
    fireEvent.click(screen.getByRole("button", { name: messages.showOriginal }))
    await screen.findByRole("button", { name: "Browser checks" })
    expect(screen.getByText(item.summary.en!)).toBeInTheDocument()
  })

  it("prefers publisher Chinese and excludes nonpublic items", async () => {
    const fetcher = vi.fn()
    vi.stubGlobal("fetch", fetcher)
    const localized = {
      ...item,
      title: { en: "English", zh: "作者的标题" },
      summary: { en: "English prose", zh: "作者的介绍" },
    }
    view(
      <>
        <DiscoverCard item={localized} onOpen={() => {}} />
        <DiscoverCard item={{ ...item, status: "private" }} onOpen={() => {}} />
      </>
    )
    fireEvent.click(screen.getByRole("button", { name: messages.translate }))
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: messages.showOriginal })
      ).toHaveAttribute("aria-pressed", "true")
    )
    expect(
      screen.getByRole("button", { name: "作者的标题" })
    ).toBeInTheDocument()
    expect(screen.getByText("作者的介绍")).toBeInTheDocument()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("translates description prose while preserving code and keeping markup inert", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const source = new URL(url).searchParams.get("q")
        return {
          ok: true,
          json: async () => [[[`中文 ${source} <script>bad()</script>`]]],
        }
      })
    )
    const fragment =
      "<p>Read <code>GLOSSARY.md</code> before testing.</p><pre><code>expect(add(a, b)).toBe(a + b)</code></pre>"
    const { container } = view(
      <TranslatedCatalogReadme fragment={fragment} item={item} />
    )
    fireEvent.click(screen.getByRole("button", { name: messages.translate }))
    await waitFor(() => expect(container.textContent).toContain("中文 Read"))
    expect(container.querySelector("code")?.textContent).toBe("GLOSSARY.md")
    expect(container.querySelector("pre code")?.textContent).toBe(
      "expect(add(a, b)).toBe(a + b)"
    )
    expect(container.querySelector("script")).toBeNull()
  })
})

describe("description translation boundary", () => {
  it("collects only allowed prose, without code, omitted headings, dropped elements or attributes", () => {
    const fragment =
      '<h1>Repeated title</h1><p title="private attribute">Visible prose <code>CODE_ONLY</code><kbd>Ctrl+C</kbd></p><pre>COMMAND</pre><script>HIDDEN</script><img alt="IMAGE"><a href="https://example.com/keep">A link</a>'
    const prose = readmeProse(fragment, ["Repeated title"]).join(" ")
    expect(prose).toContain("Visible prose")
    expect(prose).toContain("A link")
    for (const protectedText of [
      "Repeated title",
      "CODE_ONLY",
      "Ctrl+C",
      "COMMAND",
      "HIDDEN",
      "IMAGE",
      "private attribute",
      "example.com",
    ]) {
      expect(prose).not.toContain(protectedText)
    }
  })

  it("cannot turn translated strings into HTML or change protected elements", () => {
    const text = "Visible prose"
    const { container } = render(
      <ReadmeContent
        fragment={`<p>${text}<code>CODE</code><kbd>Ctrl+C</kbd></p>`}
        translations={
          new Map([
            [text, '<img src="bad" onerror="bad()">'],
            ["CODE", "changed"],
            ["Ctrl+C", "changed"],
          ])
        }
      />
    )
    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).toContain('<img src="bad" onerror="bad()">')
    expect(container.querySelector("code")?.textContent).toBe("CODE")
    expect(container.textContent).toContain("Ctrl+C")
  })
})
