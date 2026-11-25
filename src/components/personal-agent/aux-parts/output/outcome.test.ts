import { describe, expect, it } from "vitest"

import type { DispatchInfo, PersonalAgentOutputDoc } from "@/lib/types"

import {
  baseName,
  gatherDay,
  isImage,
  outcomeCounts,
  outcomeOf,
  topFolder,
} from "./outcome"

const d = (patch: Partial<DispatchInfo>) =>
  ({ ladder: "done", state: "completed", ...patch }) as DispatchInfo

describe("outcomeOf", () => {
  it("reads the ladder first, then the state", () => {
    expect(outcomeOf(d({ ladder: "merged" }))).toBe("done")
    expect(outcomeOf(d({ ladder: "checks_failed" }))).toBe("failed")
    expect(outcomeOf(d({ ladder: "pr_closed" }))).toBe("closed")
    expect(outcomeOf(d({ ladder: "mergeable" }))).toBe("open")
    expect(outcomeOf(d({ ladder: "pr_open" }))).toBe("open")
    expect(outcomeOf(d({ ladder: "working" as never, state: "failed" }))).toBe(
      "failed"
    )
    expect(
      outcomeOf(d({ ladder: "working" as never, state: "interrupted" }))
    ).toBe("closed")
  })

  it("counts each way", () => {
    expect(
      outcomeCounts([
        d({ ladder: "merged" }),
        d({ ladder: "failed" }),
        d({ ladder: "failed" }),
        d({ ladder: "mergeable" }),
      ])
    ).toEqual({ done: 1, failed: 2, closed: 0, open: 1 })
  })
})

describe("documents", () => {
  it("knows a picture by its name, and a path's folder and name", () => {
    expect(isImage("avatars/8.PNG")).toBe(true)
    expect(isImage("avatars/tray.svg")).toBe(true)
    expect(isImage("notes/weekly.md")).toBe(false)
    expect(isImage(".png")).toBe(false)
    expect(baseName("a/b/c.txt")).toBe("c.txt")
    expect(baseName("c.txt")).toBe("c.txt")
    expect(topFolder("a/b/c.txt")).toBe("a")
    expect(topFolder("c.txt")).toBe("")
  })

  it("gathers a day's documents by folder, at its newest, one alone as itself", () => {
    const doc = (path: string): PersonalAgentOutputDoc => ({
      path,
      modified_at: "2026-11-18T10:00:00Z",
      size: 1,
    })
    const e = (path: string) => ({
      kind: "doc" as const,
      key: path,
      at: "x",
      doc: doc(path),
    })
    const out = gatherDay([
      e("avatars/1.png"),
      { kind: "dispatch", key: "d1", at: "x", dispatch: 1 },
      e("avatars/2.png"),
      e("notes/one.md"),
      e("top.md"),
    ])
    expect(out.map((x) => x.key)).toEqual([
      "dir:avatars",
      "d1",
      "notes/one.md",
      "top.md",
    ])
    const folder = out[0]
    expect(folder.kind === "folder" && folder.docs.map((x) => x.path)).toEqual([
      "avatars/1.png",
      "avatars/2.png",
    ])
  })
})
