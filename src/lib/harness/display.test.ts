import { describe, expect, it } from "vitest"

import {
  formatBytes,
  formatDate,
  githubTreeUrl,
  harnessItemUrl,
  harnessLang,
  harnessOrigin,
  httpsUrl,
  itemSummary,
  itemTitle,
  knownKind,
  knownRisk,
  modelName,
  oneOf,
  pickLocalized,
  shortUrl,
  showsRuntime,
} from "./display"

describe("harnessLang", () => {
  it.each([
    ["en", "en"],
    ["zh-CN", "zh"],
    ["zh-TW", "zh"],
    ["ja", "en"],
    ["ko", "en"],
    ["es", "en"],
    ["de", "en"],
    ["fr", "en"],
    ["pt", "en"],
    ["ar", "en"],
  ] as const)("%s reads the catalog's %s", (locale, lang) => {
    expect(harnessLang(locale)).toBe(lang)
  })
})

describe("itemTitle — the interface language, then the other, then the name", () => {
  const both = { title: { en: "PDF Tools", zh: "PDF 工具" }, name: "pdf-tools" }

  it("takes the reader's language when it is there", () => {
    expect(itemTitle(both, "en")).toBe("PDF Tools")
    expect(itemTitle(both, "zh")).toBe("PDF 工具")
  })

  it("falls back to the other language", () => {
    expect(itemTitle({ title: { en: "PDF Tools" }, name: "x" }, "zh")).toBe(
      "PDF Tools"
    )
    expect(itemTitle({ title: { zh: "PDF 工具" }, name: "x" }, "en")).toBe(
      "PDF 工具"
    )
  })

  it("falls back to the name when there is no title at all", () => {
    expect(itemTitle({ title: {}, name: "pdf-tools" }, "en")).toBe("pdf-tools")
    expect(itemTitle({ title: {}, name: "pdf-tools" }, "zh")).toBe("pdf-tools")
  })

  it("treats a blank title as missing", () => {
    expect(
      itemTitle({ title: { en: "  ", zh: "工具" }, name: "x" }, "en")
    ).toBe("工具")
    expect(itemTitle({ title: { en: "", zh: " " }, name: "x" }, "zh")).toBe("x")
  })
})

describe("pickLocalized / itemSummary", () => {
  it("has nothing to pick from nothing", () => {
    expect(pickLocalized(undefined, "en")).toBeUndefined()
    expect(pickLocalized(null, "zh")).toBeUndefined()
    expect(pickLocalized({}, "en")).toBeUndefined()
  })

  it("uses a prompt's first line or an assistant's role for a missing summary", () => {
    expect(
      itemSummary(
        { summary: {}, prompt: { excerpt: "Write a haiku about…" } } as never,
        "en"
      )
    ).toBe("Write a haiku about…")
    expect(
      itemSummary(
        { summary: {}, assistant: { role: "Reviews Kotlin code" } } as never,
        "zh"
      )
    ).toBe("Reviews Kotlin code")
    expect(itemSummary({ summary: { zh: "摘要" } } as never, "en")).toBe("摘要")
    expect(itemSummary({ summary: {} } as never, "en")).toBeUndefined()
  })
})

describe("known values", () => {
  it("names the kinds and risks this build knows, and nothing else", () => {
    expect(knownKind("skill")).toBe("skill")
    expect(knownKind("connector")).toBe("connector")
    expect(knownKind("widget")).toBeNull()
    expect(knownKind(undefined)).toBeNull()
    expect(knownKind("constructor")).toBeNull()
    expect(knownRisk("medium")).toBe("medium")
    expect(knownRisk("extreme")).toBeNull()
    expect(oneOf(["ok", "yanked"] as const, "yanked")).toBe("yanked")
    expect(oneOf(["ok", "yanked"] as const, "toString")).toBeNull()
  })
})

describe("httpsUrl — the only addresses that become links", () => {
  it.each([
    ["https://example.com", "https://example.com/"],
    ["https://example.com/a?b=c#d", "https://example.com/a?b=c#d"],
    ["  https://example.com/x  ", "https://example.com/x"],
    ["HTTPS://EXAMPLE.COM/Path", "https://example.com/Path"],
  ])("lets %j through", (input, href) => {
    expect(httpsUrl(input)).toBe(href)
  })

  it.each([
    "http://example.com",
    "javascript:void(0)",
    "JaVaScRiPt:void(0)",
    "data:text/html,hello",
    "vbscript:x",
    "file:///tmp/readme.txt",
    "mailto:someone@example.com",
    "ftp://example.com",
    "//example.com/path",
    "/relative/path",
    "example.com",
    "#anchor",
    "https://name:word@example.com",
    "https://user@example.com",
    "",
    "   ",
    null,
    undefined,
    42,
    {},
  ])("refuses %j", (input) => {
    expect(httpsUrl(input)).toBeNull()
  })
})

describe("harnessOrigin / harnessItemUrl", () => {
  it("accepts https origins, and http only for this machine", () => {
    expect(harnessOrigin("https://spacering.net")).toBe("https://spacering.net")
    expect(harnessOrigin("https://spacering.net/")).toBe(
      "https://spacering.net"
    )
    expect(harnessOrigin("http://localhost:4321")).toBe("http://localhost:4321")
    expect(harnessOrigin("http://127.0.0.1:4321")).toBe("http://127.0.0.1:4321")
    expect(harnessOrigin("http://spacering.net")).toBeNull()
    expect(harnessOrigin("javascript:void(0)")).toBeNull()
    expect(harnessOrigin("https://a:b@spacering.net")).toBeNull()
    expect(harnessOrigin("")).toBeNull()
    expect(harnessOrigin(undefined)).toBeNull()
  })

  it("builds an item's page address per language", () => {
    expect(
      harnessItemUrl("https://spacering.net", "acme/pdf-tools", "en")
    ).toBe("https://spacering.net/harness/acme/pdf-tools")
    expect(
      harnessItemUrl("https://spacering.net", "acme/pdf-tools", "zh")
    ).toBe("https://spacering.net/zh/harness/acme/pdf-tools")
    expect(
      harnessItemUrl("https://spacering.net", "browser-use.com/mcp", "en")
    ).toBe("https://spacering.net/harness/browser-use.com/mcp")
  })

  it("has no address before the backend has named its origin", () => {
    expect(harnessItemUrl(null, "acme/pdf-tools", "en")).toBeNull()
  })
})

describe("githubTreeUrl", () => {
  it("points at the folder at the checked commit", () => {
    expect(
      githubTreeUrl({
        repository: "acme/skills",
        commit: "683bc88e",
        path: "skills/pdf tools",
      })
    ).toBe("https://github.com/acme/skills/tree/683bc88e/skills/pdf%20tools")
    expect(
      githubTreeUrl({ repository: "acme/skills", commit: "683bc88e", path: "" })
    ).toBe("https://github.com/acme/skills/tree/683bc88e")
  })

  it("refuses anything that is not a repository and a commit", () => {
    expect(githubTreeUrl(null)).toBeNull()
    expect(
      githubTreeUrl({ repository: "acme", commit: "683bc88e", path: "" })
    ).toBeNull()
    expect(
      githubTreeUrl({
        repository: "acme/skills/../../other",
        commit: "683bc88e",
        path: "",
      })
    ).toBeNull()
    expect(
      githubTreeUrl({ repository: "acme/skills", commit: "a b", path: "" })
    ).toBeNull()
  })

  it("drops path parts that would climb out of the repository", () => {
    expect(
      githubTreeUrl({
        repository: "acme/skills",
        commit: "683bc88e",
        path: "../../other/./x",
      })
    ).toBe("https://github.com/acme/skills/tree/683bc88e/other/x")
  })
})

describe("showsRuntime", () => {
  it("is for the kinds that run something", () => {
    expect(showsRuntime({ kind: "skill", runtime: "python" })).toBe(true)
    expect(showsRuntime({ kind: "mcp", runtime: "remote" })).toBe(true)
    expect(showsRuntime({ kind: "skill", runtime: "none" })).toBe(true)
    expect(showsRuntime({ kind: "widget", runtime: "wasm" })).toBe(true)
    expect(showsRuntime({ kind: "prompt", runtime: "none" })).toBe(false)
    expect(showsRuntime({ kind: "assistant", runtime: "none" })).toBe(false)
    expect(showsRuntime({ kind: "skill", runtime: "" })).toBe(false)
  })
})

describe("formatting", () => {
  it("shortens an address for display", () => {
    expect(shortUrl("https://www.example.com/")).toBe("example.com")
    expect(shortUrl("https://github.com/acme/skills")).toBe(
      "github.com/acme/skills"
    )
  })

  it("formats byte counts", () => {
    expect(formatBytes(0, "en")).toBe("0 B")
    expect(formatBytes(512, "en")).toBe("512 B")
    expect(formatBytes(2201, "en")).toBe("2.1 KB")
    expect(formatBytes(5 * 1024 * 1024, "en")).toBe("5 MB")
    expect(formatBytes(Number.NaN, "en")).toBe("0 B")
    expect(formatBytes(-5, "en")).toBe("0 B")
  })

  it("formats a timestamp as a date, or not at all", () => {
    expect(formatDate("2026-10-20T08:00:00.000Z", "en")).toMatch(/2026/)
    expect(formatDate("not a date", "en")).toBeNull()
    expect(formatDate("", "en")).toBeNull()
    expect(formatDate(undefined, "en")).toBeNull()
  })
})

describe("modelName", () => {
  it("names the models prompts are written for", () => {
    expect(modelName("claude-opus-5-5")).toBe("Claude Opus 5.5")
  })

  it("names the aliases an assistant gives, in any case", () => {
    expect(modelName("sonnet")).toBe("Claude Sonnet")
    expect(modelName("Opus")).toBe("Claude Opus")
  })

  it("reads other Claude ids, old spellings included", () => {
    expect(modelName("claude-sonnet-4-20250514")).toBe("Claude Sonnet 4")
    expect(modelName("claude-3-5-haiku-20241022")).toBe("Claude Haiku 3.5")
  })

  it("shows an id it cannot read as it is", () => {
    expect(modelName("gpt-5")).toBe("gpt-5")
  })

  it("leaves none, and following the session, to the interface", () => {
    expect(modelName("inherit")).toBeNull()
    expect(modelName(null)).toBeNull()
    expect(modelName("  ")).toBeNull()
    expect(modelName(5)).toBeNull()
  })
})
