import { describe, expect, it } from "vitest"
import { defaultRehypePlugins } from "streamdown"
import { unified } from "unified"

import {
  isFileName,
  relativeFileHref,
  withRelativeFileLinks,
} from "./rehype-relative-file-links"

type El = {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: El[]
}

type Plugins = Parameters<typeof withRelativeFileLinks>[0]

/**
 * Run one `<a>` through a rehype pipeline — Streamdown's own sanitize and
 * harden, with or without the relative-link steps — and return what is left
 * where it was. rehype-raw is left out: these trees hold no raw HTML.
 */
function renderAnchor(
  properties: Record<string, unknown>,
  plugins: Plugins = withRelativeFileLinks(defaultRehypePlugins)
): El {
  const tree: El = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "a",
        properties,
        children: [{ type: "text", value: "x" }],
      },
    ],
  }
  const steps = Object.entries(plugins)
    .filter(([key]) => key !== "raw")
    .map(([, plugin]) => plugin)
  const out = unified()
    .use(steps as never)
    .runSync(tree as never) as unknown as El
  return out.children![0]
}

describe("relativeFileHref", () => {
  it("keeps an explicitly relative or home path as it is", () => {
    for (const href of [
      "./index.html",
      "../site/a.md#L2",
      "./my%20notes.md",
      "~/notes/a.md",
    ]) {
      expect(relativeFileHref(href)).toBe(href)
    }
  })

  it("turns the first separator of a Windows relative path", () => {
    // A markdown destination arrives with its backslashes encoded.
    expect(relativeFileHref(".%5Csrc%5Ca.ts")).toBe("./src%5Ca.ts")
    expect(relativeFileHref("..\\x\\a.md")).toBe("../x\\a.md")
  })

  it("makes a file-shaped bare path explicit", () => {
    for (const [href, explicit] of [
      ["index.html", "./index.html"],
      ["index.html#L3", "./index.html#L3"],
      ["src/main.rs", "./src/main.rs"],
      ["src/a.ts:12", "./src/a.ts:12"],
      // `sh` is a TLD too, but here it is a script far more often than a host.
      ["deploy.sh", "./deploy.sh"],
      [".github/workflows/ci.yml", "./.github/workflows/ci.yml"],
      [".gitignore", "./.gitignore"],
      ["Dockerfile", "./Dockerfile"],
      ["LICENSE", "./LICENSE"],
      ["my%20notes.md", "./my%20notes.md"],
      ["%E8%AE%BE%E8%AE%A1.md", "./%E8%AE%BE%E8%AE%A1.md"],
    ]) {
      expect(relativeFileHref(href)).toBe(explicit)
    }
  })

  it("leaves web addresses, plain words and non-relative targets alone", () => {
    for (const href of [
      "www.example.com",
      "example.com",
      "foo.io",
      // A host in the first segment is a web address even with a path after it.
      "github.com/foo/bar",
      "example.com/docs/a.md",
      "localhost/app",
      "10.0.0.1/status",
      "v1.2.3",
      "notes",
      "#section",
      "?q=1",
      "mailto:a@b.c",
      "https://example.com/x",
      "/abs/path.md",
      "//cdn.example/x",
      // A UNC share is not carried (see NOT_BARE).
      "\\\\server\\share\\a.md",
      "%5C%5Cserver%5Cshare%5Ca.md",
      "~user/a.md",
      ".",
      "..",
      "",
    ]) {
      expect(relativeFileHref(href)).toBeNull()
    }
  })
})

describe("isFileName", () => {
  it("accepts extensions, dotfiles and extension-less project files", () => {
    for (const name of [
      "a.ts",
      "archive.7z",
      ".env.local",
      "Makefile",
      "justfile",
      "CHANGELOG",
      "CODE_OF_CONDUCT",
    ]) {
      expect(isFileName(name)).toBe(true)
    }
  })

  it("rejects hosts, versions and words", () => {
    for (const name of [
      "localhost",
      "example.com",
      "www.example.org",
      "10.0.0.1",
      "v1.2.3",
      "tel",
      "API",
      "",
    ]) {
      expect(isFileName(name)).toBe(false)
    }
  })
})

describe("the record / restore steps around harden", () => {
  it("keeps a relative link's href where harden would flatten or block it", () => {
    for (const [href, kept] of [
      ["./index.html", "./index.html"],
      ["../site/a.md#L2", "../site/a.md#L2"],
      ["index.html", "./index.html"],
      ["~/notes/a.md", "~/notes/a.md"],
    ]) {
      const node = renderAnchor({ href })
      expect(node.tagName).toBe("a")
      expect(node.properties?.href).toBe(kept)
    }
  })

  it("is what makes the difference: harden alone flattens or blocks them", () => {
    expect(
      renderAnchor({ href: "./index.html" }, defaultRehypePlugins).properties
        ?.href
    ).toBe("/index.html")
    const blocked = renderAnchor({ href: "index.html" }, defaultRehypePlugins)
    expect(blocked.tagName).toBe("span")
  })

  it("leaves absolute and web links to harden", () => {
    expect(renderAnchor({ href: "/abs/a.md" }).properties?.href).toBe(
      "/abs/a.md"
    )
    expect(
      renderAnchor({ href: "https://example.com/x" }).properties?.href
    ).toBe("https://example.com/x")
  })

  it("takes nothing from the element itself: an attribute cannot repoint a link", () => {
    // What a link is restored to comes from the record step alone, keyed by
    // the element — so an attribute written into the message (raw HTML can
    // write any) has nothing to hook onto, and sanitize drops it anyway.
    const node = renderAnchor({
      href: "/abs/a.md",
      dataCodegRelativeHref: "../x",
      "data-codeg-relative-href": "../x",
    })
    expect(node.properties).toMatchObject({ href: "/abs/a.md" })
    expect(node.properties).not.toHaveProperty("dataCodegRelativeHref")
    expect(node.properties).not.toHaveProperty("data-codeg-relative-href")
  })
})

describe("withRelativeFileLinks", () => {
  it("brackets harden with the two steps and reconfigures nothing", () => {
    const plugins = withRelativeFileLinks(defaultRehypePlugins)
    expect(Object.keys(plugins)).toEqual([
      "raw",
      "sanitize",
      "recordRelativeFileLinks",
      "harden",
      "restoreRelativeFileLinks",
    ])
    for (const [key, plugin] of Object.entries(defaultRehypePlugins)) {
      // Same entry, options included: sanitize's schema is not widened.
      expect(plugins[key]).toBe(plugin)
    }
  })

  it("still runs both, last, when there is no harden to bracket", () => {
    const { raw, sanitize } = defaultRehypePlugins
    expect(Object.keys(withRelativeFileLinks({ raw, sanitize }))).toEqual([
      "raw",
      "sanitize",
      "recordRelativeFileLinks",
      "restoreRelativeFileLinks",
    ])
  })
})
