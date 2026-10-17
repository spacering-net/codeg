import { describe, expect, it } from "vitest"
import { URI } from "monaco-editor/base/common/uri.js"
import {
  buildMonacoModelPath,
  collectLiveModelPaths,
} from "@/lib/monaco-model-path"

describe("buildMonacoModelPath", () => {
  it("keys pathless tabs on the tab id", () => {
    expect(buildMonacoModelPath(null, "diff:working-all:1")).toBe(
      "inmemory://model/diff%3Aworking-all%3A1"
    )
  })

  it("maps absolute paths to file:/// without slash inflation", () => {
    expect(buildMonacoModelPath("/repo/src/a.ts", "x")).toBe(
      "file:///repo/src/a.ts"
    )
  })

  it("keeps UNC identity distinct from the single-slash form", () => {
    const unc = buildMonacoModelPath("//server/share/a.ts", "x")
    const posix = buildMonacoModelPath("/server/share/a.ts", "x")
    expect(unc).toBe("file://server/share/a.ts")
    expect(posix).toBe("file:///server/share/a.ts")
    expect(unc).not.toBe(posix)
  })

  it("encodes special characters per segment", () => {
    expect(buildMonacoModelPath("/repo/a b#c.ts", "x")).toBe(
      "file:///repo/a%20b%23c.ts"
    )
  })

  it("is compared after Monaco normalizes Windows drive letters", () => {
    const path = buildMonacoModelPath("D:\\repo\\notes.md", "x")

    expect(path).toBe("file:///D%3A/repo/notes.md")
    expect(URI.parse(path).toString()).toBe("file:///d%3A/repo/notes.md")
  })
})

describe("collectLiveModelPaths", () => {
  it("maps file tabs to their path URI and pathless tabs to their id URI", () => {
    expect(
      collectLiveModelPaths([
        { id: "file:%2Frepo%2Fa.ts", path: "/repo/a.ts" },
        { id: "diff:working-all:1", path: null },
      ])
    ).toEqual(["file:///repo/a.ts", "inmemory://model/diff%3Aworking-all%3A1"])
  })

  it("dedupes tabs that resolve to the same model URI", () => {
    expect(
      collectLiveModelPaths([
        { id: "a", path: "/repo/a.ts" },
        { id: "b", path: "/repo/a.ts" },
      ])
    ).toEqual(["file:///repo/a.ts"])
  })

  it("returns an empty list for no tabs", () => {
    expect(collectLiveModelPaths([])).toEqual([])
  })
})
