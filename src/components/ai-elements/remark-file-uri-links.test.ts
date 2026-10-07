import { describe, expect, it } from "vitest"
import { remarkRewriteFileUriLinks } from "./remark-file-uri-links"

// Minimal mdast node shapes for the transform.
type Node = {
  type: string
  url?: string
  identifier?: string
  children?: Node[]
}

function linkTree(url: string): Node {
  return {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [{ type: "link", url, children: [{ type: "text" }] }],
      },
    ],
  }
}

function firstLinkUrl(tree: Node): string | undefined {
  let found: string | undefined
  const walk = (n: Node) => {
    if (n.type === "link") found = n.url
    n.children?.forEach(walk)
  }
  walk(tree)
  return found
}

function rewrite(url: string): string | undefined {
  const tree = linkTree(url)
  remarkRewriteFileUriLinks()(tree)
  return firstLinkUrl(tree)
}

describe("remarkRewriteFileUriLinks", () => {
  it("rewrites a POSIX file:// URI to a bare local path", () => {
    expect(rewrite("file:///Users/a/b.ts")).toBe("/Users/a/b.ts")
  })

  it("keeps the leading slash before a Windows drive letter (sanitize-safe)", () => {
    // A bare `C:/…` would make rehype-sanitize read `C:` as a URL protocol and
    // strip the href (→ harden's "[blocked]"); `/C:/…` keeps `C:` out of
    // protocol position. Downstream link-safety strips the slash before opening.
    expect(rewrite("file:///C:/x/y.ts")).toBe("/C:/x/y.ts")
  })

  it("prefixes a slash onto a bare Windows drive path (forward slashes)", () => {
    expect(rewrite("E:/Desktop/docs/G.docx")).toBe("/E:/Desktop/docs/G.docx")
  })

  it("prefixes a slash onto a bare Windows drive path (backslashes)", () => {
    expect(rewrite("C:\\Users\\a\\b.docx")).toBe("/C:\\Users\\a\\b.docx")
  })

  it("prefixes a slash onto a Chinese/encoded bare Windows drive path", () => {
    expect(rewrite("E:/桌面/使用手册/G手册.docx")).toBe(
      "/E:/桌面/使用手册/G手册.docx"
    )
    expect(rewrite("E:/My%20Docs/%E6%89%8B%E5%86%8C.docx")).toBe(
      "/E:/My%20Docs/%E6%89%8B%E5%86%8C.docx"
    )
  })

  it("leaves a bare relative path to the rehype step (not a drive path)", () => {
    // `C:` needs a following slash to be a drive path. A relative path gets
    // past sanitize as it is; the `./` it needs is added after sanitize, in
    // rehype-relative-file-links, where raw HTML anchors are covered too.
    expect(rewrite("src/main.rs")).toBe("src/main.rs")
    expect(rewrite("notes.md")).toBe("notes.md")
    expect(rewrite("./index.html")).toBe("./index.html")
  })

  it("puts a root file position behind a slash so sanitize keeps it", () => {
    // `a.ts:12` reads as a URL with the scheme `a.ts:`; `./a.ts:12` does not.
    expect(rewrite("a.ts:12")).toBe("./a.ts:12")
    expect(rewrite("index.html:3:7")).toBe("./index.html:3:7")
    expect(rewrite(".env:2")).toBe("./.env:2")
    expect(rewrite("Makefile:40")).toBe("./Makefile:40")
    // With a directory the colon already sits behind a slash.
    expect(rewrite("src/a.ts:12")).toBe("src/a.ts:12")
  })

  it("leaves a host with a port, and other schemes, as they are", () => {
    for (const url of [
      "localhost:3000",
      "example.com:8080",
      "10.0.0.1:80",
      "tel:12345",
      "mailto:a@b.c",
      "a.ts:L12",
    ]) {
      expect(rewrite(url)).toBe(url)
    }
  })

  it("rewrites a reference definition the same way", () => {
    const tree: Node = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "linkReference",
              identifier: "pos",
              children: [{ type: "text" }],
            },
          ],
        },
        { type: "definition", identifier: "pos", url: "a.ts:12" },
      ],
    }
    remarkRewriteFileUriLinks()(tree)
    expect(tree.children![1].url).toBe("./a.ts:12")
  })

  it("emits a UNC file:// URI as a backslash UNC path (unambiguously local)", () => {
    // //server/share would be indistinguishable from a protocol-relative
    // web url downstream; the backslash form tags it as a local file.
    expect(rewrite("file://server/share/doc.md")).toBe(
      "\\\\server\\share\\doc.md"
    )
  })

  it("preserves fragments on rewritten links", () => {
    expect(rewrite("file:///Users/a/b.ts#L12")).toBe("/Users/a/b.ts#L12")
  })

  it("leaves non-file URLs untouched", () => {
    expect(rewrite("https://example.com/x")).toBe("https://example.com/x")
  })
})
