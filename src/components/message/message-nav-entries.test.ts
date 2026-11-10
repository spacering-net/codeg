import { describe, expect, it } from "vitest"
import type { DelegationCardSource } from "@/hooks/use-delegation-card-model"
import type { FileChangeStat } from "@/lib/session-files"
import type { MessageTurn } from "@/lib/types"
import {
  buildMessageNavEntries,
  mergeFileChangesByPath,
} from "./message-nav-entries"

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

function edits(
  id: string,
  path: string,
  changes: [before: string, after: string][]
): MessageTurn {
  return {
    id,
    role: "assistant",
    blocks: changes.map(([before, after], index) => ({
      type: "tool_use" as const,
      tool_use_id: `${id}-edit-${index}`,
      tool_name: "Edit",
      input_preview: JSON.stringify({
        file_path: path,
        old_string: before,
        new_string: after,
      }),
    })),
    timestamp: "2026-10-01T08:00:01Z",
  }
}

const DELEGATION_META = {
  "codeg.delegation": { status: "completed", child_conversation_id: 7 },
}

/** An assistant turn of the outline: tool calls kept, results dropped. */
function delegations(
  id: string,
  calls: { id: string; name?: string; meta?: Record<string, unknown> }[]
): MessageTurn {
  return {
    id,
    role: "assistant",
    blocks: calls.map((call) => ({
      type: "tool_use" as const,
      tool_use_id: call.id,
      tool_name: call.name ?? "mcp__codeg-mcp__delegate_to_agent",
      input_preview: JSON.stringify({ agent_type: "codex", task: call.id }),
      meta: call.meta ?? null,
    })),
    timestamp: "2026-10-01T08:00:01Z",
  }
}

function loaded(id: string): DelegationCardSource {
  return { parentToolUseId: id, input: null, state: "output-available" }
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

  it("lists a file the round changed several times once", () => {
    const entries = buildMessageNavEntries({
      earlierTurns: null,
      earlierUserCount: 0,
      loadedTurns: [
        user("turn-0", "first"),
        edits("turn-1", "/repo/a.ts", [
          ["one", "uno"],
          ["two", "dos\ntres"],
        ]),
        write("turn-2", "/repo/b.ts"),
      ],
      threadIndexByTurnId: new Map([["turn-0", 0]]),
    })
    const [entry] = entries
    expect(entry.files.map((f) => f.path)).toEqual(["/repo/a.ts", "/repo/b.ts"])
    const [a] = entry.files
    expect([a.additions, a.deletions]).toEqual([3, 2])
    // The two edits' diffs, one after the other.
    expect(a.diff).toContain("+uno")
    expect(a.diff).toContain("+tres")
    expect(a.diff!.indexOf("+uno")).toBeLessThan(a.diff!.indexOf("+tres"))
    // The totals are the round's, as before.
    expect([entry.additions, entry.deletions]).toEqual([5, 2])
  })

  it("lists each loaded message's sub-agents", () => {
    const first = [loaded("tu-1"), loaded("tu-2")]
    const entries = buildMessageNavEntries({
      earlierTurns: null,
      earlierUserCount: 0,
      loadedTurns: [
        user("turn-0", "first"),
        reply("turn-1"),
        user("turn-2", "second"),
      ],
      threadIndexByTurnId: new Map([
        ["turn-0", 0],
        ["turn-2", 2],
      ]),
      loadedSubAgents: {
        byUserTurnId: new Map([["turn-0", first]]),
        leading: [],
      },
    })
    expect(entries[0].subAgents).toBe(first)
    expect(entries[1].subAgents).toEqual([])
  })

  it("lists the sub-agents history above the window shows ran", () => {
    const entries = buildMessageNavEntries({
      earlierTurns: [
        user("turn-0", "first"),
        delegations("turn-1", [
          { id: "ran", meta: DELEGATION_META },
          // Refused before it started: no snapshot of a run.
          { id: "refused" },
          // Its result, which says whether it was refused, isn't outlined.
          {
            id: "resumed",
            name: "mcp__codeg-mcp__resume_delegation",
            meta: DELEGATION_META,
          },
        ]),
      ],
      earlierUserCount: 1,
      loadedTurns: [],
      threadIndexByTurnId: new Map(),
    })
    expect(entries[0].subAgents).toEqual([
      {
        parentToolUseId: "ran",
        input: JSON.stringify({ agent_type: "codex", task: "ran" }),
        output: null,
        errorText: null,
        state: "output-available",
        meta: DELEGATION_META,
      },
    ])
  })

  it("lists an OpenCode code-mode delegation history above the window ran", () => {
    // OpenCode 2.x runs MCP calls inside its `execute` tool: the block keeps
    // that name and carries the real call in its `code` source.
    const input = JSON.stringify({
      code: 'await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: `t` })',
    })
    const entries = buildMessageNavEntries({
      earlierTurns: [
        user("turn-0", "first"),
        {
          id: "turn-1",
          role: "assistant",
          blocks: [
            {
              type: "tool_use",
              tool_use_id: "exec-ran",
              tool_name: "execute",
              input_preview: input,
              meta: DELEGATION_META,
            },
            // Any other script is no delegation, whatever meta it carries.
            {
              type: "tool_use",
              tool_use_id: "exec-other",
              tool_name: "execute",
              input_preview: JSON.stringify({ code: "return 1 + 1" }),
              meta: DELEGATION_META,
            },
            // Nor is another tool's `code` argument shaped like the call.
            {
              type: "tool_use",
              tool_use_id: "browser-1",
              tool_name: "mcp__playwright__browser_run_code",
              input_preview: input,
              meta: DELEGATION_META,
            },
          ],
          timestamp: "2026-10-01T08:00:01Z",
        },
      ],
      earlierUserCount: 1,
      loadedTurns: [],
      threadIndexByTurnId: new Map(),
    })
    expect(entries[0].subAgents.map((s) => s.parentToolUseId)).toEqual([
      "exec-ran",
    ])
    expect(entries[0].subAgents[0].input).toBe(input)
  })

  it("collects a round's sub-agents across the window start", () => {
    const entries = buildMessageNavEntries({
      earlierTurns: [
        user("turn-0", "first"),
        delegations("turn-1", [{ id: "above", meta: DELEGATION_META }]),
      ],
      earlierUserCount: 1,
      loadedTurns: [reply("turn-2"), user("turn-3", "next")],
      threadIndexByTurnId: new Map([["turn-3", 1]]),
      loadedSubAgents: {
        byUserTurnId: new Map(),
        leading: [loaded("below")],
      },
    })
    expect(entries[0].subAgents.map((s) => s.parentToolUseId)).toEqual([
      "above",
      "below",
    ])
    expect(entries[1].subAgents).toEqual([])
  })
})

describe("buildMessageNavEntries across the window start", () => {
  // The rendered overlay copy of a message whose history copy is above the
  // window: listed where the history puts it, with that copy's round.
  it("takes a message's sub-agents from the copy its files come from", () => {
    const entries = buildMessageNavEntries({
      earlierTurns: [
        user("turn-0", "first"),
        delegations("turn-1", [{ id: "above", meta: DELEGATION_META }]),
      ],
      earlierUserCount: 1,
      loadedTurns: [
        reply("turn-2"),
        user("turn-3", "next"),
        user("turn-0", "first"),
      ],
      threadIndexByTurnId: new Map([
        ["turn-3", 1],
        ["turn-0", 2],
      ]),
      loadedSubAgents: {
        byUserTurnId: new Map([["turn-0", [loaded("twin")]]]),
        leading: [loaded("below")],
      },
    })
    expect(entries.map((e) => [e.turnId, e.threadIndex])).toEqual([
      ["turn-0", 2],
      ["turn-3", 1],
    ])
    expect(entries[0].subAgents.map((s) => s.parentToolUseId)).toEqual([
      "above",
      "below",
    ])
  })

  // The resume re-binds the child to the call above the window, whose row
  // tracks the resumed run — as it does when the whole round is loaded.
  it("lists a sub-agent resumed across the window start once", () => {
    const entries = buildMessageNavEntries({
      earlierTurns: [
        user("turn-0", "first"),
        delegations("turn-1", [
          {
            id: "started",
            meta: {
              "codeg.delegation": {
                status: "running",
                child_conversation_id: 7,
                task_id: "task-1",
              },
            },
          },
        ]),
      ],
      earlierUserCount: 1,
      loadedTurns: [reply("turn-2")],
      threadIndexByTurnId: new Map(),
      loadedSubAgents: {
        byUserTurnId: new Map(),
        leading: [
          { ...loaded("resumed"), taskIdHint: "task-1" },
          { ...loaded("other-resume"), taskIdHint: "task-2" },
        ],
      },
    })
    expect(entries[0].subAgents.map((s) => s.parentToolUseId)).toEqual([
      "started",
      "other-resume",
    ])
  })
})

// Every streaming batch rebuilds the entries of the whole conversation, and
// only the round being answered has changed: the rest keep their objects, so
// the store finds them unchanged without comparing their files.
describe("buildMessageNavEntries across rebuilds", () => {
  const first = user("turn-0", "first")
  const edit = write("turn-1", "/repo/a.ts")
  const second = user("turn-2", "second")
  const thread = new Map([
    ["turn-0", 0],
    ["turn-2", 2],
  ])
  const build = (
    loadedTurns: MessageTurn[],
    over: Partial<Parameters<typeof buildMessageNavEntries>[0]> = {}
  ) =>
    buildMessageNavEntries({
      earlierTurns: null,
      earlierUserCount: 0,
      loadedTurns,
      threadIndexByTurnId: thread,
      ...over,
    })

  it("hands back a message's entry while its round is the same", () => {
    const before = build([first, edit, second, reply("turn-3")])
    const after = build([first, edit, second, write("turn-3", "/repo/b.ts")])
    expect(after[0]).toBe(before[0])
    expect(after[1]).not.toBe(before[1])
    expect(after[1].files.map((f) => f.path)).toEqual(["/repo/b.ts"])
  })

  it("builds a message's entry anew once it moves or is renumbered", () => {
    const turns = [first, edit, second]
    const before = build(turns)
    const moved = build(turns, {
      threadIndexByTurnId: new Map([
        ["turn-0", 1],
        ["turn-2", 3],
      ]),
    })
    expect(moved[0]).not.toBe(before[0])
    expect(moved.map((e) => e.threadIndex)).toEqual([1, 3])
    // The same files, still.
    expect(moved[0].files).toBe(before[0].files)
    const renumbered = build(turns, { earlierUserCount: 4 })
    expect(renumbered.map((e) => e.ordinal)).toEqual([5, 6])
  })

  it("builds a message's entry anew once its sub-agents change", () => {
    const turns = [first, edit, second]
    const tu1 = loaded("tu-1")
    const listed = (sources: DelegationCardSource[]) => ({
      byUserTurnId: new Map([["turn-0", sources]]),
      leading: [],
    })
    const before = build(turns, { loadedSubAgents: listed([tu1]) })
    // The same sources in a new list: what every batch hands it.
    const same = build(turns, { loadedSubAgents: listed([tu1]) })
    expect(same[0]).toBe(before[0])
    const more = build(turns, {
      loadedSubAgents: listed([tu1, loaded("tu-2")]),
    })
    expect(more[0]).not.toBe(before[0])
    expect(more[0].subAgents.map((s) => s.parentToolUseId)).toEqual([
      "tu-1",
      "tu-2",
    ])
  })
})

describe("mergeFileChangesByPath", () => {
  const change = (
    id: string,
    path: string,
    additions: number,
    diff: string | null
  ): FileChangeStat => ({ id, path, additions, deletions: 0, diff })

  it("hands back the same list when no file repeats", () => {
    const files = [change("1", "a.ts", 1, "+a"), change("2", "b.ts", 1, null)]
    expect(mergeFileChangesByPath(files)).toBe(files)
  })

  it("keeps a file changed once as it was, and the first id of one changed again", () => {
    const once = change("2", "b.ts", 1, "+b")
    const merged = mergeFileChangesByPath([
      change("1", "a.ts", 1, "+a"),
      once,
      change("3", "a.ts", 2, null),
      change("4", "a\\b.ts", 0, null),
      change("5", "a/b.ts", 4, "+c"),
    ])
    expect(merged).toEqual([
      { id: "1", path: "a.ts", additions: 3, deletions: 0, diff: "+a" },
      once,
      { id: "4", path: "a\\b.ts", additions: 4, deletions: 0, diff: "+c" },
    ])
    expect(merged[1]).toBe(once)
  })
})
