/**
 * Member timeline store — the receiving end of the backend's Agent Teams member
 * channel (`member_chunk` events).
 *
 * Covered invariants:
 *  - live chunks (no `history_item_id`) accumulate into the member's trailing
 *    unfinalized buffer, message and thought kept apart;
 *  - a committed-record echo (`history_item_id`) REPLACES the unfinalized
 *    buffer with its own authoritative text and finalizes it under
 *    `item:{historyItemId}`;
 *  - the same `history_item_id` never inserts twice — the agent replays full
 *    member history on every re-subscribe (3s interval) and again after a
 *    session reopen, so a replayed run must rebuild the same timeline with no
 *    duplicates;
 *  - tool frames merge by `toolCallId` and a replayed opening frame cannot
 *    un-settle a terminal status;
 *  - a rekeyed connection carries its timelines to the new key; a removed one
 *    drops them.
 */

import { beforeEach, describe, expect, it } from "vitest"

import {
  applyMemberChunkToItems,
  selectMemberTimelines,
  useMemberTimelineStore,
  type MemberChunkEvent,
  type MemberTimelineItem,
} from "@/stores/member-timeline-store"

function chunk(overrides: Partial<MemberChunkEvent>): MemberChunkEvent {
  return {
    type: "member_chunk",
    member: "impl-x",
    kind: "message",
    ...overrides,
  }
}

function text(text: string, historyItemId?: string): MemberChunkEvent {
  return chunk({
    kind: "message",
    text,
    history_item_id: historyItemId ?? null,
  })
}

function thought(text: string, historyItemId?: string): MemberChunkEvent {
  return chunk({
    kind: "thought",
    text,
    history_item_id: historyItemId ?? null,
  })
}

function userEcho(text: string, historyItemId?: string): MemberChunkEvent {
  return chunk({
    kind: "user_echo",
    text,
    history_item_id: historyItemId ?? null,
  })
}

function toolCall(
  id: string,
  title?: string,
  status?: string,
  historyItemId?: string
): MemberChunkEvent {
  return chunk({
    kind: "tool_call",
    text: null,
    tool_call_id: id,
    title: title ?? null,
    status: status ?? null,
    history_item_id: historyItemId ?? null,
  })
}

function toolUpdate(
  id: string,
  status?: string,
  title?: string,
  historyItemId?: string
): MemberChunkEvent {
  return chunk({
    kind: "tool_call_update",
    text: null,
    tool_call_id: id,
    title: title ?? null,
    status: status ?? null,
    history_item_id: historyItemId ?? null,
  })
}

function timeline(contextKey: string, member = "impl-x"): MemberTimelineItem[] {
  return (
    selectMemberTimelines(useMemberTimelineStore.getState(), contextKey)?.[
      member
    ] ?? []
  )
}

function textsOf(items: MemberTimelineItem[]): string[] {
  return items.map((item) => ("text" in item ? item.text : item.toolCallId))
}

function apply(contextKey: string, ...chunks: MemberChunkEvent[]): void {
  for (const c of chunks) {
    useMemberTimelineStore.getState().applyMemberChunk(contextKey, c)
  }
}

beforeEach(() => {
  useMemberTimelineStore.getState().clearAll()
})

describe("applyMemberChunkToItems — live buffers", () => {
  it("accumulates message deltas into one unfinalized item", () => {
    const items = applyMemberChunkToItems([], text("你"))
    expect(items).toEqual([
      { id: "live:0", kind: "message", text: "你", final: false },
    ])
    const next = applyMemberChunkToItems(items, text("好"))
    expect(next).toEqual([
      { id: "live:0", kind: "message", text: "你好", final: false },
    ])
  })

  it("keeps message and thought buffers apart", () => {
    const items = [...[text("prose 1")], ...[thought("hmm")]].reduce(
      applyMemberChunkToItems,
      [] as MemberTimelineItem[]
    )
    expect(items).toEqual([
      { id: "live:0", kind: "message", text: "prose 1", final: false },
      { id: "live:1", kind: "thought", text: "hmm", final: false },
    ])
    // A later message delta appends to the MESSAGE buffer (live:0), not the
    // trailing thought one.
    const next = [text("prose 2")].reduce(applyMemberChunkToItems, items)
    expect(next[0]).toEqual({
      id: "live:0",
      kind: "message",
      text: "prose 1prose 2",
      final: false,
    })
    expect(next[1]).toEqual({
      id: "live:1",
      kind: "thought",
      text: "hmm",
      final: false,
    })
  })
})

describe("applyMemberChunkToItems — committed-record echoes", () => {
  it("replaces the unfinalized buffer with the echo and finalizes it", () => {
    const items = [text("已"), text("确认")].reduce(
      applyMemberChunkToItems,
      [] as MemberTimelineItem[]
    )
    const next = applyMemberChunkToItems(
      items,
      text("已确认所有方案。", "hist-1")
    )
    expect(next).toEqual([
      {
        id: "item:hist-1",
        kind: "message",
        text: "已确认所有方案。",
        final: true,
      },
    ])
  })

  it("appends the record when no live buffer exists (reopen replay)", () => {
    const next = applyMemberChunkToItems([], text("历史消息", "hist-9"))
    expect(next).toEqual([
      { id: "item:hist-9", kind: "message", text: "历史消息", final: true },
    ])
  })

  it("does not insert the same history_item_id twice — any number of replays", () => {
    const first = applyMemberChunkToItems([], text("记录", "hist-2"))
    const second = applyMemberChunkToItems(first, text("记录", "hist-2"))
    expect(second).toBe(first) // no-op reference: the store can bail out
    // A live buffer started after the finalize is untouched by the replay.
    const withBuffer = applyMemberChunkToItems(second, text("new "))
    const afterReplay = applyMemberChunkToItems(
      withBuffer,
      text("记录", "hist-2")
    )
    expect(afterReplay).toBe(withBuffer)
  })

  it("finalizes with an echo even when the buffer was created by an earlier echo-free run", () => {
    const items = [
      { id: "item:u1", kind: "user", text: "请写两句" } as MemberTimelineItem,
      {
        id: "live:1",
        kind: "thought",
        text: "思考",
        final: false,
      } as MemberTimelineItem,
    ]
    const next = applyMemberChunkToItems(items, thought("思考完整版", "h-2"))
    expect(next[1]).toEqual({
      id: "item:h-2",
      kind: "thought",
      text: "思考完整版",
      final: true,
    })
    expect(next[2]).toBeUndefined()
  })
})

describe("applyMemberChunkToItems — tool frames", () => {
  it("merges an update onto the opening call by tool_call_id", () => {
    const items = applyMemberChunkToItems(
      [],
      toolCall("call_1", "SendMessage", "pending", "t1")
    )
    expect(items).toEqual([
      {
        id: "tool:call_1",
        kind: "tool",
        toolCallId: "call_1",
        title: "SendMessage",
        status: "pending",
      },
    ])
    const next = applyMemberChunkToItems(
      items,
      toolUpdate("call_1", "completed", undefined, "t2")
    )
    expect(next).toEqual([
      {
        id: "tool:call_1",
        kind: "tool",
        toolCallId: "call_1",
        title: "SendMessage",
        status: "completed",
      },
    ])
  })

  it("never lets a replayed opening frame un-settle a terminal status", () => {
    const items = [toolCall("call_1", "SendMessage", "pending")].reduce(
      applyMemberChunkToItems,
      [] as MemberTimelineItem[]
    )
    const settled = applyMemberChunkToItems(
      items,
      toolUpdate("call_1", "completed")
    )
    // A replay re-announces the call as `pending`…
    const replayed = applyMemberChunkToItems(
      settled,
      toolCall("call_1", "SendMessage", "pending")
    )
    // …and the row stays completed, with no title churn.
    expect(replayed).toBe(settled)
  })

  it("ignores tool frames without an id", () => {
    const items = applyMemberChunkToItems([], toolCall("", "x", "pending"))
    expect(items).toEqual([])
  })
})

describe("member timeline store — per member, per connection", () => {
  it("buckets by member name under the connection key", () => {
    apply("tab-1", text("a"), thought("t"))
    apply("tab-1", chunk({ member: "impl-y", kind: "message", text: "b" }))
    apply("tab-2", text("other"))
    expect(textsOf(timeline("tab-1", "impl-x"))).toEqual(["a", "t"])
    expect(textsOf(timeline("tab-1", "impl-y"))).toEqual(["b"])
    expect(textsOf(timeline("tab-2", "impl-x"))).toEqual(["other"])
  })

  it("rebuilds the same timeline from a replayed run and dedups the replay", () => {
    // The wire order of one member's committed history: the kickoff message,
    // its reply record, then a tool pair.
    const replay: MemberChunkEvent[] = [
      userEcho("<teammate-message>hi</teammate-message>", "u1"),
      text("已确认。", "m1"),
      toolCall("call_1", "SendMessage", "pending", "t1"),
      toolUpdate("call_1", "completed", undefined, "t2"),
    ]
    apply("tab-1", ...replay)
    const first = timeline("tab-1")
    expect(first).toEqual([
      {
        id: "item:u1",
        kind: "user",
        text: "<teammate-message>hi</teammate-message>",
      },
      { id: "item:m1", kind: "message", text: "已确认。", final: true },
      {
        id: "tool:call_1",
        kind: "tool",
        toolCallId: "call_1",
        title: "SendMessage",
        status: "completed",
      },
    ])

    // Session reopen: the agent replays the same history. No duplicates, and
    // no state change at all (the store bails out of a re-render).
    const stateBefore = useMemberTimelineStore.getState()
    const membersBefore = selectMemberTimelines(stateBefore, "tab-1")
    apply("tab-1", ...replay)
    const stateAfter = useMemberTimelineStore.getState()
    expect(selectMemberTimelines(stateAfter, "tab-1")).toBe(membersBefore)
    expect(timeline("tab-1")).toEqual(first)
  })

  it("finishes the timeline: echo after deltas, then later live chunks start fresh", () => {
    apply(
      "tab-1",
      thought("The"),
      thought(" lead"),
      thought("The lead asks", "h1"),
      text("已"),
      text("按队要求发送。", "m2"),
      text("(next)")
    )
    expect(timeline("tab-1")).toEqual([
      { id: "item:h1", kind: "thought", text: "The lead asks", final: true },
      { id: "item:m2", kind: "message", text: "按队要求发送。", final: true },
      { id: "live:2", kind: "message", text: "(next)", final: false },
    ])
  })

  it("rekey carries the timelines; clear drops them", () => {
    apply("tab-1", text("keep me"))
    useMemberTimelineStore.getState().rekeyContext("tab-1", "tab-9")
    expect(timeline("tab-1")).toEqual([])
    expect(textsOf(timeline("tab-9"))).toEqual(["keep me"])

    useMemberTimelineStore.getState().clearContext("tab-9")
    expect(timeline("tab-9")).toEqual([])
  })

  it("clearAll empties every connection", () => {
    apply("tab-1", text("a"))
    apply("tab-2", text("b"))
    useMemberTimelineStore.getState().clearAll()
    expect(
      selectMemberTimelines(useMemberTimelineStore.getState(), "tab-1")
    ).toBeUndefined()
    expect(
      selectMemberTimelines(useMemberTimelineStore.getState(), "tab-2")
    ).toBeUndefined()
  })
})
