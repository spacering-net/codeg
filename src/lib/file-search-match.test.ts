import { describe, expect, it } from "vitest"
import {
  fileMatchHighlights,
  rankFileMatches,
  scoreFileMatch,
  sliceHighlightRanges,
  type FileSearchCandidate,
} from "@/lib/file-search-match"

/** Build a candidate from a relative path (basename derived from the path). */
function cand(path: string): FileSearchCandidate {
  const lowerPath = path.toLowerCase()
  const lastSlash = lowerPath.lastIndexOf("/")
  return {
    lowerPath,
    lowerName: lastSlash === -1 ? lowerPath : lowerPath.slice(lastSlash + 1),
  }
}

function rankPaths(query: string, paths: string[], limit = 100): string[] {
  const items = paths.map((p) => ({ ...cand(p), path: p }))
  return rankFileMatches(query, items, limit).map((i) => i.path)
}

describe("scoreFileMatch tiers", () => {
  it("orders exact > prefix > name-substring > path-substring > subsequence", () => {
    const q = "app"
    const exact = scoreFileMatch(q, "app", "src/app")!
    const prefix = scoreFileMatch(q, "app.tsx", "src/app.tsx")!
    const nameSub = scoreFileMatch(q, "myapp.tsx", "src/myapp.tsx")!
    const pathSub = scoreFileMatch(q, "index.tsx", "app/index.tsx")!
    const subseq = scoreFileMatch(q, "a-p-p.tsx", "x/a-p-p.tsx")!

    expect(exact).toBeGreaterThan(prefix)
    expect(prefix).toBeGreaterThan(nameSub)
    expect(nameSub).toBeGreaterThan(pathSub)
    expect(pathSub).toBeGreaterThan(subseq)
  })

  it("returns null when nothing matches", () => {
    expect(scoreFileMatch("zzz", "readme.md", "docs/readme.md")).toBeNull()
  })

  it("prefers earlier match position, then shorter candidate, within a tier", () => {
    const early = scoreFileMatch("bar", "barstool.ts", "a/barstool.ts")!
    const late = scoreFileMatch("bar", "foobar.ts", "a/foobar.ts")!
    expect(early).toBeGreaterThan(late) // prefix beats substring anyway

    const short = scoreFileMatch("bar", "xbar.ts", "a/xbar.ts")!
    const long = scoreFileMatch(
      "bar",
      "xbar-longer-name.ts",
      "a/xbar-longer-name.ts"
    )!
    expect(short).toBeGreaterThan(long) // same position, shorter wins
  })
})

describe("rankFileMatches", () => {
  it("returns the first `limit` items unchanged for an empty query", () => {
    const paths = ["a.ts", "b.ts", "c.ts"]
    expect(rankPaths("", paths, 2)).toEqual(["a.ts", "b.ts"])
  })

  it("is case-insensitive on the query", () => {
    expect(rankPaths("README", ["src/readme.md", "src/other.ts"])).toEqual([
      "src/readme.md",
    ])
  })

  it("surfaces a deeply nested file whose name matches ahead of loose path hits", () => {
    const deep = "a/b/c/d/e/f/g/h/i/j/k/config.ts"
    const paths = [
      "src/index.ts",
      "src/configuration-loader.ts", // name substring "config"
      deep, // exact-ish name "config.ts" (prefix match on name)
    ]
    const ranked = rankPaths("config", paths)
    // The deep file's basename ("config.ts") is a prefix match, which outranks
    // the shallower "configuration-loader.ts" name-substring match. Depth does
    // not penalise it — the core fix.
    expect(ranked[0]).toBe(deep)
    expect(ranked).toContain("src/configuration-loader.ts")
    expect(ranked).not.toContain("src/index.ts")
  })

  it("matches via subsequence when there is no substring hit", () => {
    expect(rankPaths("fbz", ["x/foobarbaz.ts", "x/nope.ts"])).toEqual([
      "x/foobarbaz.ts",
    ])
  })

  it("matches on path segments, not just the basename", () => {
    const ranked = rankPaths("components/", [
      "src/components/button.tsx",
      "src/lib/util.ts",
    ])
    expect(ranked).toEqual(["src/components/button.tsx"])
  })

  it("caps results at `limit`, keeping the best matches", () => {
    const paths = Array.from({ length: 50 }, (_, i) => `src/item-${i}.ts`)
    const ranked = rankPaths("item", paths, 10)
    expect(ranked).toHaveLength(10)
  })
})

describe("fileMatchHighlights", () => {
  const marked = (query: string, path: string) =>
    fileMatchHighlights(query, path)
      .map(([s, e]) => path.slice(s, e))
      .join("|")

  it("highlights a name substring in the basename, not an earlier dir", () => {
    // "app" also occurs in the directory; the name hit is what ranked the row.
    expect(fileMatchHighlights("app", "app/src/App.tsx")).toEqual([[8, 11]])
  })

  it("falls back to a path substring", () => {
    expect(marked("src/ap", "app/src/App.tsx")).toBe("src/Ap")
  })

  it("marks the characters of a subsequence, merging adjacent ones", () => {
    expect(marked("fsm", "lib/file-search-match.ts")).toBe("f|s|m")
    expect(marked("abt", "abc/tab.ts")).toBe("ab|t")
  })

  it("is case-insensitive and trims the query", () => {
    expect(marked("  README ", "docs/readme.md")).toBe("readme")
  })

  it("returns nothing for a blank or non-matching query", () => {
    expect(fileMatchHighlights("   ", "a.ts")).toEqual([])
    expect(fileMatchHighlights("zzz", "a.ts")).toEqual([])
  })
})

describe("sliceHighlightRanges", () => {
  it("clips and rebases ranges to a window", () => {
    expect(
      sliceHighlightRanges(
        [
          [0, 2],
          [4, 9],
          [12, 14],
        ],
        5,
        10
      )
    ).toEqual([[0, 4]])
  })
})
