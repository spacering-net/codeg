import { describe, expect, it } from "vitest"
import type { MessageTurn } from "@/lib/types"
import { buildMessageNavEntries } from "./message-nav-entries"

function user(id: string, text: string): MessageTurn {
  return {
    id,
    role: "user",
    blocks: [{ type: "text", text }],
    timestamp: "2026-10-01T08:00:00Z",
  }
}

function write(id: string, path: string): MessageTurn {
  return {
    id,
    role: "assistant",
    blocks: [
      {
        type: "tool_use",
        tool_use_id: `${id}-call`,
        tool_name: "Write",
        input_preview: JSON.stringify({ file_path: path, content: "x\n" }),
      },
    ],
    timestamp: "2026-10-01T08:00:01Z",
  }
}

function reply(id: string): MessageTurn {
  return {
    id,
    role: "assistant",
    blocks: [{ type: "text", text: "done" }],
    timestamp: "2026-10-01T08:00:01Z",
  }
}

// Global transcript: turn-0 … turn-5. The window starts at turn-4.
const EARLIER = [
  user("turn-0", "first"),
  write("turn-1", "/repo/a.ts"),
  user("turn-2", "second"),
  reply("turn-3"),
]
const LOADED = [user("turn-4", "third"), write("turn-5", "/repo/b.ts")]
// Thread items: a loader row is not counted; turn-4 renders at index 0.
const THREAD_INDEX = new Map([["turn-4", 0]])

describe("buildMessageNavEntries", () => {
  it("lists every message, numbering the earlier ones first", () => {
    const entries = buildMessageNavEntries({
      earlierTurns: EARLIER,
      earlierUserCount: 2,
      loadedTurns: LOADED,
      threadIndexByTurnId: THREAD_INDEX,
    })
    expect(
      entries.map((e) => [e.ordinal, e.label, e.threadIndex, e.turnIndex])
    ).toEqual([
      [1, "first", null, 0],
      [2, "second", null, 2],
      [3, "third", 0, null],
    ])
    expect(entries[0].files.map((f) => f.path)).toEqual(["/repo/a.ts"])
    expect(entries[1].hasChanges).toBe(false)
    expect(entries[2].files.map((f) => f.path)).toEqual(["/repo/b.ts"])
  })

  it("numbers the loaded messages on from the unlisted ones above them", () => {
    const entries = buildMessageNavEntries({
      earlierTurns: null,
      earlierUserCount: 2,
      loadedTurns: LOADED,
      threadIndexByTurnId: THREAD_INDEX,
    })
    expect(entries.map((e) => [e.ordinal, e.label, e.threadIndex])).toEqual([
      [3, "third", 0],
    ])
  })

  it("collects a round's files across the window start", () => {
    // The window starts mid-round (the backend's round alignment is capped):
    // the prompt is above it, the edit inside it.
    const entries = buildMessageNavEntries({
      earlierTurns: [user("turn-0", "first"), reply("turn-1")],
      earlierUserCount: 1,
      loadedTurns: [write("turn-2", "/repo/c.ts"), user("turn-3", "next")],
      threadIndexByTurnId: new Map([["turn-3", 1]]),
    })
    expect(entries.map((e) => e.label)).toEqual(["first", "next"])
    expect(entries[0].files.map((f) => f.path)).toEqual(["/repo/c.ts"])
    expect(entries[0].turnIndex).toBe(0)
  })

  it("lists a message held by both lists once, where the history puts it", () => {
    // A background overlay copy of turn-2 renders in the thread while its
    // persisted twin is still above the window.
    const entries = buildMessageNavEntries({
      earlierTurns: EARLIER,
      earlierUserCount: 2,
      loadedTurns: [...LOADED, user("turn-2", "second")],
      threadIndexByTurnId: new Map([
        ["turn-4", 0],
        ["turn-2", 2],
      ]),
    })
    expect(
      entries.map((e) => [e.ordinal, e.turnId, e.threadIndex, e.turnIndex])
    ).toEqual([
      [1, "turn-0", null, 0],
      [2, "turn-2", 2, null],
      [3, "turn-4", 0, null],
    ])
  })

  it("prefers the rendered copy of a message over its outline entry", () => {
    const entries = buildMessageNavEntries({
      earlierTurns: [user("turn-0", "first")],
      earlierUserCount: 1,
      loadedTurns: [],
      threadIndexByTurnId: new Map([["turn-0", 4]]),
    })
    expect(entries.map((e) => [e.threadIndex, e.turnIndex])).toEqual([
      [4, null],
    ])
  })
})
