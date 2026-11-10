import { describe, expect, it } from "vitest"

import {
  changedLineRangeFromUnifiedDiff,
  describeEditFiles,
  editDiffText,
} from "./edit"

describe("changedLineRangeFromUnifiedDiff", () => {
  it("spans only the changed lines, not the context around them", () => {
    const diff = [
      "--- a/q.py",
      "+++ b/q.py",
      "@@ -42,4 +42,6 @@",
      " .model_copy(",
      "     {",
      '-        "source_bindings": tuple(b for b in item.source_bindings),',
      '+        "source_bindings": tuple(',
      "+            b for b in item.source_bindings if b.active",
      "+        ),",
      "     }",
    ].join("\n")
    expect(changedLineRangeFromUnifiedDiff(diff)).toEqual({
      start: 44,
      end: 46,
    })
  })

  it("covers every hunk of the file", () => {
    const diff = [
      "@@ -3,1 +3,1 @@",
      "-a",
      "+b",
      "@@ -90,2 +90,3 @@",
      " x",
      "+y",
      " z",
    ].join("\n")
    expect(changedLineRangeFromUnifiedDiff(diff)).toEqual({
      start: 3,
      end: 91,
    })
  })

  it("returns null without hunk headers", () => {
    expect(changedLineRangeFromUnifiedDiff("+a\n-b")).toBeNull()
  })
})

describe("describeEditFiles", () => {
  it("reads every file of an apply_patch with its own counts", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      "-old",
      "+new",
      "+more",
      "*** Add File: src/b.ts",
      "+export {}",
      "*** Update File: src/c.ts",
      "*** Move to: src/d.ts",
      "-x",
      "*** End Patch",
    ].join("\n")
    expect(
      describeEditFiles("apply_patch", JSON.stringify({ input: patch }), null)
    ).toEqual([
      {
        path: "src/a.ts",
        op: "update",
        additions: 2,
        deletions: 1,
        lineRange: null,
      },
      {
        path: "src/b.ts",
        op: "add",
        additions: 1,
        deletions: 0,
        lineRange: null,
      },
      {
        path: "src/d.ts",
        fromPath: "src/c.ts",
        op: "move",
        additions: 0,
        deletions: 1,
        lineRange: null,
      },
    ])
  })

  it("uses the injected start line for a live Claude edit", () => {
    const input = JSON.stringify({
      file_path: "/repo/q.py",
      old_string: "a\nb\nc",
      new_string: "a\nB1\nB2\nc",
      _start_line: 40,
    })
    expect(describeEditFiles("edit", input, null)).toEqual([
      {
        path: "/repo/q.py",
        op: "update",
        additions: 2,
        deletions: 1,
        lineRange: { start: 41, end: 42 },
      },
    ])
  })

  it("prefers the rebuilt structured patch in a reloaded Claude edit", () => {
    const input = JSON.stringify({
      file_path: "/repo/q.py",
      old_string: "x",
      new_string: "y",
    })
    const output = "--- a/q.py\n+++ b/q.py\n@@ -7,1 +7,1 @@\n-x\n+y"
    expect(describeEditFiles("edit", input, output)).toEqual([
      {
        path: "/repo/q.py",
        op: "update",
        additions: 1,
        deletions: 1,
        lineRange: { start: 7, end: 7 },
      },
    ])
  })

  it("does not guess a range for replace_all or a missing start line", () => {
    const input = JSON.stringify({
      file_path: "/repo/q.py",
      old_string: "x",
      new_string: "y",
      replace_all: true,
      _start_line: 3,
    })
    expect(describeEditFiles("edit", input, null)[0]?.lineRange).toBeNull()
  })

  it("reads codex's changes map", () => {
    const input = JSON.stringify({
      changes: {
        "src/a.ts": { unified_diff: "@@ -1,1 +1,2 @@\n a\n+b" },
        "src/new.ts": { content: "x\ny" },
      },
    })
    expect(describeEditFiles("edit", input, null)).toEqual([
      {
        path: "src/a.ts",
        op: "update",
        additions: 1,
        deletions: 0,
        lineRange: { start: 2, end: 2 },
      },
      {
        path: "src/new.ts",
        op: "add",
        additions: 2,
        deletions: 0,
        lineRange: null,
      },
    ])
  })

  it("counts a Write as new content and leaves a notebook edit uncounted", () => {
    expect(
      describeEditFiles(
        "write",
        JSON.stringify({ file_path: "/r/a.md", content: "1\n2\n3\n" }),
        null
      )
    ).toEqual([
      {
        path: "/r/a.md",
        op: "write",
        additions: 3,
        deletions: null,
        lineRange: null,
      },
    ])
    expect(
      describeEditFiles(
        "notebookedit",
        JSON.stringify({ notebook_path: "/r/n.ipynb", new_source: "x" }),
        null
      )[0]
    ).toMatchObject({ path: "/r/n.ipynb", additions: null, deletions: null })
  })

  it("accepts OpenCode's camelCase spelling", () => {
    const input = JSON.stringify({
      filePath: "/r/a.ts",
      oldString: "a",
      newString: "b",
    })
    expect(describeEditFiles("edit", input, null)).toEqual([
      {
        path: "/r/a.ts",
        op: "update",
        additions: 1,
        deletions: 1,
        lineRange: null,
      },
    ])
  })

  it("returns nothing for an empty payload", () => {
    expect(describeEditFiles("edit", null, null)).toEqual([])
  })
})

describe("editDiffText", () => {
  // OpenCode 2 names the file `path` on edit and write
  // (packages/core/src/tool/plugin/{edit,write}.ts, 2.2.0 capture).
  it("heads an OpenCode 2 write's diff with its path", () => {
    const diff = editDiffText(
      "write",
      JSON.stringify({ path: "new.txt", content: "alpha\nbeta\n" }),
      "Created file successfully: new.txt"
    )
    expect(diff?.text.split("\n").slice(0, 2)).toEqual([
      "--- a/new.txt",
      "+++ b/new.txt",
    ])
  })

  it("heads an OpenCode 2 edit's diff with its path", () => {
    const diff = editDiffText(
      "edit",
      JSON.stringify({
        path: "new.txt",
        oldString: "beta",
        newString: "gamma",
      }),
      "Edited new.txt (1 replacement)"
    )
    expect(diff?.text.split("\n").slice(0, 2)).toEqual([
      "--- a/new.txt",
      "+++ b/new.txt",
    ])
  })
})
