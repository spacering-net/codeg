import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it, expect, vi } from "vitest"
import {
  extractReplyFileChanges,
  extractSessionFilesGrouped,
  warmTurnFileChanges,
} from "./session-files"
import { isAddedFileDiff, isRemovedFileDiff } from "./file-path-display"
import type { MessageTurn } from "./types"

function userTurn(id: string, text: string): MessageTurn {
  return {
    id,
    role: "user",
    blocks: [{ type: "text", text }],
    timestamp: "2024-01-01T00:00:00Z",
  }
}

function writeTurn(
  id: string,
  toolId: string,
  filePath: string,
  content: string
): MessageTurn {
  return {
    id,
    role: "assistant",
    blocks: [
      {
        type: "tool_use",
        tool_use_id: toolId,
        tool_name: "Write",
        input_preview: JSON.stringify({ file_path: filePath, content }),
      },
    ],
    timestamp: "2024-01-01T00:00:01Z",
  }
}

describe("extractSessionFilesGrouped", () => {
  it("drops user turns with no edits by default", () => {
    const turns = [
      userTurn("u1", "hello"),
      userTurn("u2", "write a file"),
      writeTurn("a2", "t2", "/repo/src/a.ts", "a\nb\nc\n"),
    ]

    const groups = extractSessionFilesGrouped(turns)

    expect(groups).toHaveLength(1)
    expect(groups[0].userTurnId).toBe("u2")
    expect(groups[0].files).toHaveLength(1)
  })

  it("includeEmpty keeps a placeholder for every user turn, in order", () => {
    const turns = [
      userTurn("u1", "hello"),
      userTurn("u2", "write a file"),
      writeTurn("a2", "t2", "/repo/src/a.ts", "a\nb\nc\n"),
      userTurn("u3", "thanks"),
    ]

    const groups = extractSessionFilesGrouped(turns, { includeEmpty: true })

    // One slot per user message, preserving conversation order.
    expect(groups.map((g) => g.userTurnId)).toEqual(["u1", "u2", "u3"])
    // No-edit turns are placeholders with an empty file list.
    expect(groups[0].files).toEqual([])
    expect(groups[2].files).toEqual([])
    // The edited turn carries the file + line counts the rail surfaces.
    const edited = groups[1]
    expect(edited.userMessage).toBe("write a file")
    expect(edited.files).toHaveLength(1)
    expect(edited.files[0].path).toBe("/repo/src/a.ts")
    expect(edited.files[0].additions).toBeGreaterThan(0)
  })

  it("returns an empty array when there are no user turns", () => {
    expect(extractSessionFilesGrouped([], { includeEmpty: true })).toEqual([])
    expect(extractSessionFilesGrouped([])).toEqual([])
  })

  it("numbers a reused turn's files by their place in each grouping", () => {
    // Per-turn results are memoized by turn object; the id suffix is the
    // file's position in its group, so the same turn object must still get
    // position-dependent ids in different groupings.
    const shared = writeTurn("a1", "t1", "/repo/x.ts", "x\n")
    const alone = extractSessionFilesGrouped([userTurn("u1", "go"), shared])
    const second = extractSessionFilesGrouped([
      userTurn("u1", "go"),
      writeTurn("a0", "t0", "/repo/w.ts", "w\n"),
      shared,
    ])
    expect(alone[0].files.map((f) => f.id)).toEqual(["a1:t1:0:0"])
    expect(second[0].files.map((f) => f.id)).toEqual(["a0:t0:0:0", "a1:t1:0:1"])
  })

  it("reads a replaced turn afresh", () => {
    const before = writeTurn("a1", "t1", "/repo/x.ts", "x\n")
    const after: MessageTurn = {
      ...before,
      blocks: [
        {
          type: "tool_use",
          tool_use_id: "t1",
          tool_name: "Write",
          input_preview: JSON.stringify({
            file_path: "/repo/y.ts",
            content: "y\ny\n",
          }),
        },
      ],
    }
    const u = userTurn("u1", "go")
    expect(extractSessionFilesGrouped([u, before])[0].files[0].path).toBe(
      "/repo/x.ts"
    )
    expect(extractSessionFilesGrouped([u, after])[0].files[0].path).toBe(
      "/repo/y.ts"
    )
  })
})

describe("warmTurnFileChanges", () => {
  /** A write turn that counts how often its blocks are read: to parse it,
   *  and never again while it stays parsed. */
  function countedTurn(id: string) {
    const turn = writeTurn(id, `${id}-t`, `/repo/${id}.ts`, "x\n")
    const blocks = turn.blocks
    const counted = { reads: 0, turn }
    Object.defineProperty(turn, "blocks", {
      get: () => {
        counted.reads += 1
        return blocks
      },
    })
    return counted
  }

  it("parses every turn ahead of the grouping, at once when it fits", () => {
    const a = countedTurn("a1")
    const done = vi.fn()
    warmTurnFileChanges([userTurn("u1", "go"), a.turn], done)
    expect(done).toHaveBeenCalledTimes(1)
    const parsed = a.reads
    expect(parsed).toBeGreaterThan(0)
    const [group] = extractSessionFilesGrouped([userTurn("u1", "go"), a.turn])
    expect(group.files.map((f) => f.path)).toEqual(["/repo/a1.ts"])
    expect(a.reads).toBe(parsed)
  })

  it("lets the main thread go between slices of a long history", async () => {
    const turns = [countedTurn("a1"), countedTurn("a2"), countedTurn("a3")]
    const done = vi.fn()
    // No time to spare: a slice per turn.
    warmTurnFileChanges(
      turns.map((t) => t.turn),
      done,
      0
    )
    expect(done).not.toHaveBeenCalled()
    expect(turns.map((t) => t.reads > 0)).toEqual([true, false, false])
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1))
    expect(turns.map((t) => t.reads > 0)).toEqual([true, true, true])
  })

  it("is done even with a turn it can't parse", () => {
    const broken = writeTurn("a1", "t1", "/repo/x.ts", "x\n")
    Object.defineProperty(broken, "blocks", {
      get: () => {
        throw new Error("unreadable")
      },
    })
    const done = vi.fn()
    warmTurnFileChanges([broken], done)
    expect(done).toHaveBeenCalledTimes(1)
  })
})

describe("the backend's message navigator outline", () => {
  // `full` is a parsed transcript and `outline` what the backend's
  // `nav_outline_turns` makes of it — the Rust test checks that side.
  const vector = JSON.parse(
    readFileSync(
      join(process.cwd(), "src-tauri/tests/fixtures/nav_outline_vector.json"),
      "utf8"
    )
  ) as { full: MessageTurn[]; outline: MessageTurn[] }

  it("indexes exactly like the full transcript", () => {
    expect(
      extractSessionFilesGrouped(vector.outline, { includeEmpty: true })
    ).toEqual(extractSessionFilesGrouped(vector.full, { includeEmpty: true }))
  })

  it("exercises the labels and tool outputs the outline has to keep", () => {
    const groups = extractSessionFilesGrouped(vector.full, {
      includeEmpty: true,
    })
    expect(groups.map((g) => g.userMessage)).toEqual([
      "Make the parser stream its output, then update the docs and the changelog so ...",
      "User message",
      "",
    ])
    const diffOf = (path: string) =>
      groups[0].files.find((f) => f.path === path)?.diff
    // An agent-produced diff (a line starting with "@@ ") is used as-is.
    expect(diffOf("/repo/src/parser.rs")).toMatch(
      /^The file \/repo\/src\/parser\.rs has been updated\.\n@@ /
    )
    // Only the first result that is not an error and has output is read.
    expect(diffOf("/repo/CHANGELOG.md")).toBe(
      "@@ -1,1 +1,3 @@\n ## Unreleased\n+\n+- Streaming parser."
    )
    // A first result without a hunk header falls back to the edit itself,
    // even when a later result has one.
    expect(diffOf("/repo/README.md")).toContain("+new line")
    expect(diffOf("/repo/README.md")).not.toContain("never read")
  })
})

function editTurn(
  id: string,
  toolId: string,
  filePath: string,
  oldString: string,
  newString: string
): MessageTurn {
  return {
    id,
    role: "assistant",
    blocks: [
      {
        type: "tool_use",
        tool_use_id: toolId,
        tool_name: "Edit",
        input_preview: JSON.stringify({
          file_path: filePath,
          old_string: oldString,
          new_string: newString,
        }),
      },
    ],
    timestamp: "2024-01-01T00:00:01Z",
  }
}

function applyPatchTurn(
  id: string,
  toolId: string,
  patch: string
): MessageTurn {
  return {
    id,
    role: "assistant",
    blocks: [
      {
        type: "tool_use",
        tool_use_id: toolId,
        tool_name: "apply_patch",
        input_preview: JSON.stringify({ input: patch }),
      },
    ],
    timestamp: "2024-01-01T00:00:01Z",
  }
}

describe("extractReplyFileChanges", () => {
  it("aggregates the same file edited across sub-turns into one row", () => {
    const first = writeTurn("a1", "t1", "/repo/src/a.ts", "line1\nline2\n")
    const second = writeTurn(
      "a2",
      "t2",
      "/repo/src/a.ts",
      "line3\nline4\nline5\n"
    )

    const soloA = extractReplyFileChanges([first])[0].additions
    const soloB = extractReplyFileChanges([second])[0].additions
    const files = extractReplyFileChanges([first, second])

    // One row per path; counts summed across sub-turns; diff chunks joined.
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe("/repo/src/a.ts")
    expect(files[0].additions).toBe(soloA + soloB)
    expect(files[0].diff).toBeTruthy()
  })

  it("lists distinct files as separate rows in first-seen order", () => {
    const files = extractReplyFileChanges([
      writeTurn("a1", "t1", "/repo/src/b.ts", "x\n"),
      editTurn("a2", "t2", "/repo/src/a.ts", "old", "new"),
    ])

    expect(files.map((f) => f.path)).toEqual([
      "/repo/src/b.ts",
      "/repo/src/a.ts",
    ])
  })

  it("ignores user turns and non-write tool calls", () => {
    const files = extractReplyFileChanges([
      userTurn("u1", "please read the file"),
      {
        id: "a1",
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            tool_use_id: "t1",
            tool_name: "Read",
            input_preview: JSON.stringify({ file_path: "/repo/src/a.ts" }),
          },
          { type: "text", text: "done" },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
    ])

    expect(files).toEqual([])
  })

  // The artifacts card splits "new files" from "changed files" by inspecting
  // each aggregated diff. Guard the extraction→classification contract: a write
  // reads as created, an edit reads as modified (not created).
  it("produces diffs the card classifies as created (write) vs modified (edit)", () => {
    const [written] = extractReplyFileChanges([
      writeTurn("a1", "t1", "/repo/src/new.ts", "line1\nline2\n"),
    ])
    expect(isAddedFileDiff(written.diff)).toBe(true)
    expect(isRemovedFileDiff(written.diff)).toBe(false)

    const [edited] = extractReplyFileChanges([
      editTurn("a2", "t2", "/repo/src/old.ts", "const a = 1", "const a = 2"),
    ])
    expect(isAddedFileDiff(edited.diff)).toBe(false)
    expect(isRemovedFileDiff(edited.diff)).toBe(false)
  })

  it("classifies an apply_patch Add File as created", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: /repo/src/added.ts",
      "+brand new",
      "*** End Patch",
    ].join("\n")

    const [added] = extractReplyFileChanges([applyPatchTurn("a1", "t1", patch)])

    expect(added.path).toBe("/repo/src/added.ts")
    expect(isAddedFileDiff(added.diff)).toBe(true)
  })

  it("flags a deleted file so the card can style it as removed", () => {
    const patch = [
      "*** Begin Patch",
      "*** Delete File: /repo/src/gone.ts",
      "-old line",
      "*** End Patch",
    ].join("\n")

    const files = extractReplyFileChanges([applyPatchTurn("a1", "t1", patch)])

    expect(files).toHaveLength(1)
    expect(files[0].path).toBe("/repo/src/gone.ts")
    expect(isRemovedFileDiff(files[0].diff)).toBe(true)
  })

  // Codex synthesizes some `apply_patch` calls into an edit-shaped payload
  // (no patch text). These must still report +/- and an inline diff.
  it("handles apply_patch with a synthesized {file_path, old_string, new_string} payload", () => {
    const turn: MessageTurn = {
      id: "a1",
      role: "assistant",
      blocks: [
        {
          type: "tool_use",
          tool_use_id: "t1",
          tool_name: "apply_patch",
          input_preview: JSON.stringify({
            file_path: "/repo/src/a.ts",
            old_string: "const a = 1",
            new_string: "const a = 2\nconst b = 3",
          }),
        },
      ],
      timestamp: "2024-01-01T00:00:01Z",
    }

    const files = extractReplyFileChanges([turn])

    expect(files).toHaveLength(1)
    expect(files[0].path).toBe("/repo/src/a.ts")
    expect(files[0].additions + files[0].deletions).toBeGreaterThan(0)
    expect(files[0].diff).toBeTruthy()
  })

  it("handles apply_patch with a synthesized {changes:{path:{old_text,new_text}}} payload", () => {
    const turn: MessageTurn = {
      id: "a1",
      role: "assistant",
      blocks: [
        {
          type: "tool_use",
          tool_use_id: "t1",
          tool_name: "apply_patch",
          input_preview: JSON.stringify({
            changes: {
              "/repo/src/a.ts": {
                old_text: "one\ntwo",
                new_text: "one\ntwo\nthree",
              },
            },
          }),
        },
      ],
      timestamp: "2024-01-01T00:00:01Z",
    }

    const files = extractReplyFileChanges([turn])

    expect(files).toHaveLength(1)
    expect(files[0].path).toBe("/repo/src/a.ts")
    expect(files[0].additions + files[0].deletions).toBeGreaterThan(0)
    expect(files[0].diff).toBeTruthy()
  })

  it("keeps per-file diffs distinct in a multi-file changes payload (no leakage)", () => {
    const turn: MessageTurn = {
      id: "a1",
      role: "assistant",
      blocks: [
        {
          type: "tool_use",
          tool_use_id: "t1",
          tool_name: "apply_patch",
          input_preview: JSON.stringify({
            changes: {
              // One entry carries a nested `diff` (a patch-text key); the deep
              // search must NOT treat it as the whole payload's patch.
              "/repo/src/a.ts": {
                diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new",
              },
              "/repo/src/b.ts": {
                old_text: "one",
                new_text: "one\ntwo\nthree",
              },
            },
          }),
        },
      ],
      timestamp: "2024-01-01T00:00:01Z",
    }

    const files = extractReplyFileChanges([turn])
    // Exactly the two change keys — no phantom `src/a.ts` row from the nested
    // diff's own `+++ b/src/a.ts` header.
    expect(files.map((f) => f.path)).toEqual([
      "/repo/src/a.ts",
      "/repo/src/b.ts",
    ])

    const byPath = Object.fromEntries(files.map((f) => [f.path, f]))
    const a = byPath["/repo/src/a.ts"]
    const b = byPath["/repo/src/b.ts"]

    // a.ts resolves its own nested diff.
    expect(a.diff ?? "").toContain("+new")
    // b.ts must resolve its OWN change, not inherit a.ts's diff/stats.
    expect(b.diff ?? "").toContain("three")
    expect(b.diff ?? "").not.toContain("+new")
    expect(b.diff ?? "").not.toContain("src/a.ts")
    expect(b.additions).toBeGreaterThan(0)
  })

  // The message navigator shares `extractFilePaths`, so guard it too.
  it("extractSessionFilesGrouped emits no phantom path for a nested-diff changes payload", () => {
    const groups = extractSessionFilesGrouped([
      userTurn("u1", "edit two files"),
      {
        id: "a1",
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            tool_use_id: "t1",
            tool_name: "apply_patch",
            input_preview: JSON.stringify({
              changes: {
                "/repo/src/a.ts": {
                  diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new",
                },
                "/repo/src/b.ts": { old_text: "one", new_text: "one\ntwo" },
              },
            }),
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0].files.map((f) => f.path)).toEqual([
      "/repo/src/a.ts",
      "/repo/src/b.ts",
    ])
  })
})
