import { describe, expect, it } from "vitest"

import { classifyLinkTarget, parseLocalFileTarget } from "./link-classify"

describe("classifyLinkTarget", () => {
  it.each([
    ["/repo/src/app.ts", "/repo/src/app.ts", null],
    ["/repo/src/app.ts:42", "/repo/src/app.ts", 42],
    ["./src/app.ts", "./src/app.ts", null],
    ["../src/app.ts", "../src/app.ts", null],
    ["~/notes/todo.md", "~/notes/todo.md", null],
    ["C:\\repo\\a.png", "C:/repo/a.png", null],
    ["file:///repo/src/app.ts#L10", "/repo/src/app.ts", 10],
    ["\\\\server\\share\\x.txt", "//server/share/x.txt", null],
  ])("classifies %s as a local file", (input, path, line) => {
    expect(classifyLinkTarget(input)).toEqual({
      kind: "file",
      target: { path, line },
    })
  })

  it.each([
    ["mailto:hi@example.com", "mailto:"],
    ["tel:+15550100", "tel:"],
    ["MAILTO:Upper@Example.com", "mailto:"],
  ])("routes %s to the OS handler", (input, protocol) => {
    expect(classifyLinkTarget(input)).toEqual({
      kind: "os-handler",
      protocol,
      url: input,
    })
  })

  it("keeps http(s) URLs as typed and exposes the parsed URL", () => {
    const result = classifyLinkTarget("  https://example.com/a?b=1#c  ")
    expect(result.kind).toBe("http")
    if (result.kind !== "http") throw new Error("unreachable")
    expect(result.url).toBe("https://example.com/a?b=1#c")
    expect(result.parsed.hostname).toBe("example.com")
  })

  it("pins a protocol-relative URL to https", () => {
    const result = classifyLinkTarget("//example.com/docs")
    expect(result).toMatchObject({
      kind: "http",
      url: "https://example.com/docs",
    })
  })

  it.each([
    "vscode://file/repo/src/app.ts",
    "javascript:alert(1)",
    "data:text/html,<b>x</b>",
    "ftp://example.com/file",
    "tauri://localhost/",
    "#section",
    "src/main.rs",
    "www.example.com",
  ])("refuses %s as unsupported (never handed to the OS)", (input) => {
    expect(classifyLinkTarget(input)).toEqual({ kind: "unsupported" })
  })

  it("treats blank input as empty", () => {
    expect(classifyLinkTarget("   ")).toEqual({ kind: "empty" })
    expect(classifyLinkTarget("")).toEqual({ kind: "empty" })
  })
})

describe("parseLocalFileTarget (moved from link-safety, behaviour pinned)", () => {
  it("does not mistake a protocol-relative web URL for a path", () => {
    expect(parseLocalFileTarget("//example.com/x")).toBeNull()
  })

  it("keeps a UNC host from a file:// URI", () => {
    expect(parseLocalFileTarget("file://server/share/x.txt")).toEqual({
      path: "//server/share/x.txt",
      line: null,
    })
  })

  it("reads GitHub-style line ranges from the fragment", () => {
    expect(parseLocalFileTarget("/repo/a.ts#L10-25")).toEqual({
      path: "/repo/a.ts",
      line: 10,
    })
  })
})
