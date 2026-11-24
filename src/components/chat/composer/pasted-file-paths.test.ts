import { describe, expect, it } from "vitest"

import type { ClipboardFile } from "@/lib/clipboard-files"

import { pairPastedFilesWithPaths } from "./pasted-file-paths"

// What WKWebView hands a page for a Finder copy (measured against a real
// WKWebView): one `File` per copied entry with its name, size and type, a
// folder as size 0, and a clipboard image as a synthesized `image.png`.
function pasted(name: string, size: number, type = ""): File {
  return new File([new Uint8Array(size)], name, { type })
}

function entry(
  path: string,
  size: number | null,
  isDir = false
): ClipboardFile {
  return { path, name: path.split("/").pop()!, size, isDir }
}

describe("pairPastedFilesWithPaths", () => {
  it("gives every file of a Finder copy its path, in paste order", () => {
    const files = [
      pasted("bundle.zip", 117, "application/zip"),
      pasted("shot.png", 70, "image/png"),
      pasted("Makefile", 14),
    ]
    const entries = [
      entry("/work/bundle.zip", 117),
      entry("/work/shot.png", 70),
      entry("/work/Makefile", 14),
    ]
    expect(pairPastedFilesWithPaths(files, entries)).toEqual({
      paths: ["/work/bundle.zip", "/work/shot.png", "/work/Makefile"],
      rest: [],
    })
  })

  it("pairs a copied folder, which arrives as an empty file", () => {
    const files = [pasted("assets", 0), pasted("bundle.zip", 117)]
    const entries = [
      entry("/work/assets", null, true),
      entry("/work/bundle.zip", 117),
    ]
    expect(pairPastedFilesWithPaths(files, entries).paths).toEqual([
      "/work/assets",
      "/work/bundle.zip",
    ])
  })

  it("leaves bytes with no file behind them to be sent as bytes", () => {
    const screenshot = pasted("image.png", 70, "image/png")
    expect(pairPastedFilesWithPaths([screenshot], [])).toEqual({
      paths: [],
      rest: [screenshot],
    })
  })

  it("does not pair a same-named file whose size differs", () => {
    const file = pasted("notes.md", 9)
    const result = pairPastedFilesWithPaths([file], [entry("/a/notes.md", 10)])
    expect(result).toEqual({ paths: [], rest: [file] })
  })

  it("keeps two same-named files from different folders apart", () => {
    const files = [pasted("README.md", 5), pasted("README.md", 8)]
    const entries = [entry("/a/README.md", 8), entry("/b/README.md", 5)]
    expect(pairPastedFilesWithPaths(files, entries).paths).toEqual([
      "/b/README.md",
      "/a/README.md",
    ])
  })

  it("pairs each entry once, so a duplicate falls back to its bytes", () => {
    const first = pasted("a.txt", 3)
    const second = pasted("a.txt", 3)
    const result = pairPastedFilesWithPaths(
      [first, second],
      [entry("/x/a.txt", 3)]
    )
    expect(result).toEqual({ paths: ["/x/a.txt"], rest: [second] })
  })

  it("matches names whatever Unicode normalization each side used", () => {
    const composed = "café.txt".normalize("NFC")
    const decomposed = "café.txt".normalize("NFD")
    const result = pairPastedFilesWithPaths(
      [pasted(composed, 4)],
      [{ path: `/x/${decomposed}`, name: decomposed, size: 4, isDir: false }]
    )
    expect(result.paths).toEqual([`/x/${decomposed}`])
  })
})
