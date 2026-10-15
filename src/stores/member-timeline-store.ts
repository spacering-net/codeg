import { create } from "zustand"

import type { AcpEvent } from "@/lib/types"
import { registerBackendScopedStoreReset } from "@/stores/backend-scoped-store-reset"

/**
 * Per-member timeline of an Agent Teams session's member channel.
 *
 * The backend reroutes CodeBuddy `_meta.codebuddy.ai/memberEvent` frames here as
 * `member_chunk` events (the CLI's documented contract: route them to the
 * member's conversation timeline, never the main conversation area — see the
 * Rust `AcpEvent::MemberChunk`). This store is that member timeline: events are
 * bucketed BY MEMBER NAME, keyed by the connection's contextKey.
 *
 * Two frame shapes arrive on the channel, and they must compose:
 *
 *  - LIVE chunks (no `history_item_id`) — a member's prose / thought deltas and
 *    its tool activity as it happens. Text deltas accumulate into the member's
 *    trailing unfinalized buffer, one buffer per kind (message vs thought —
 *    the main thread's prose/thinking split).
 *  - COMMITTED-RECORD ECHOES (`history_item_id` set, `codebuddy.ai/memberHistoryItemId`)
 *    — the whole committed record re-sent verbatim. The echo is authoritative:
 *    it REPLACES the member's matching unfinalized buffer with its own text and
 *    becomes a finalized item keyed `item:{historyItemId}`.
 *
 * The echo id is the whole idempotency story. The agent replays a member's full
 * history on every re-subscribe (bridge start and the 3s progress interval) and
 * again after a session reopen, so the SAME frames arrive repeatedly. A
 * finalized item is inserted at most once per `item:{historyItemId}`; a replayed
 * tool frame merges by `toolCallId` and can never downgrade a settled status.
 * No codeg-side persistence is involved: a reopened conversation rebuilds the
 * timeline from the agent's own replay (see the backend notes), which is what
 * the dedup keys make safe.
 *
 * Lifecycle: the store is per-connection live state, NOT persisted. The
 * connections layer rekeys it with its connection (`REKEY_CONNECTION`) and drops
 * it when a connection entry is removed, exactly like the streaming queue.
 */
export type MemberTimelineItem =
  | {
      /** `item:{historyItemId}` once finalized, `live:{n}` while streaming. */
      id: string
      kind: "message"
      text: string
      /** True when a committed-record echo finalized this text. */
      final: boolean
    }
  | {
      id: string
      kind: "thought"
      text: string
      final: boolean
    }
  | {
      /** Always `item:{historyItemId}` in practice (the echo names the record). */
      id: string
      kind: "user"
      text: string
    }
  | {
      /** `tool:{toolCallId}` — tool frames merge onto this key. */
      id: string
      kind: "tool"
      toolCallId: string
      title: string | null
      status: string | null
    }

/** The member-channel slice of the event union (wire payload as emitted). */
export type MemberChunkEvent = Extract<AcpEvent, { type: "member_chunk" }>

/**
 * Tool statuses that must never roll back. The backend forwards the ACP status
 * via the same `format!("{:?}").to_lowercase()` the main thread uses
 * (`pending` / `inprogress` / `completed` / `failed` — mirroring
 * `is_terminal_tool_call_status` in `acp::lifecycle`). A replayed
 * `tool_call` opening frame re-announces the call as `pending`; without this
 * guard a replay that arrives after the completion would un-settle the row.
 */
const TERMINAL_TOOL_STATUSES = new Set(["completed", "failed"])

function isTerminalToolStatus(status: string | null | undefined): boolean {
  return status != null && TERMINAL_TOOL_STATUSES.has(status)
}

/** The id a committed-record echo claims (`item:{historyItemId}`). */
export function memberHistoryItemKey(historyItemId: string): string {
  return `item:${historyItemId}`
}

/** A member's streaming prose / reasoning item. */
type MemberTextItem = Extract<
  MemberTimelineItem,
  { kind: "message" | "thought" }
>

/** Constructor kept behind one narrowing point (the kind is a union here). */
function textItem(
  id: string,
  kind: "message" | "thought",
  text: string,
  final: boolean
): MemberTextItem {
  return kind === "message"
    ? { id, kind: "message", text, final }
    : { id, kind: "thought", text, final }
}

/**
 * Apply one member-channel event to a member's timeline. Pure; returns the SAME
 * array reference when the event changes nothing (a replay duplicate, an empty
 * delta), so the store can bail out of a re-render cheaply.
 */
export function applyMemberChunkToItems(
  items: MemberTimelineItem[],
  chunk: MemberChunkEvent
): MemberTimelineItem[] {
  switch (chunk.kind) {
    case "message":
    case "thought": {
      const kind = chunk.kind
      const text = chunk.text ?? ""
      if (chunk.history_item_id) {
        const id = memberHistoryItemKey(chunk.history_item_id)
        // The echo may be replayed any number of times — insert it once.
        if (items.some((item) => item.id === id)) return items
        // Authoritative: the echo's text IS the committed record, replacing
        // whatever the live deltas had accumulated (they are its prefix). With
        // no buffer to finalize (a reopen replay, or the echo arrives first)
        // the record still belongs on the timeline.
        const buffer = lastUnfinalizedTextItem(items, kind)
        if (buffer) {
          return replaceItem(
            items,
            buffer.index,
            textItem(id, kind, text, true)
          )
        }
        return [...items, textItem(id, kind, text, true)]
      }
      if (text.length === 0) return items
      const buffer = lastUnfinalizedTextItem(items, kind)
      if (buffer) {
        return replaceItem(items, buffer.index, {
          ...buffer.item,
          text: buffer.item.text + text,
        })
      }
      return [...items, textItem(liveItemId(items), kind, text, false)]
    }
    case "user_echo": {
      const text = chunk.text ?? ""
      if (text.length === 0) return items
      if (chunk.history_item_id) {
        const id = memberHistoryItemKey(chunk.history_item_id)
        if (items.some((item) => item.id === id)) return items
        return [...items, { id, kind: "user", text }]
      }
      // In practice every user echo is a committed record; a history-less one
      // still renders, it just cannot dedup a replay.
      return [...items, { id: liveItemId(items), kind: "user", text }]
    }
    case "tool_call":
    case "tool_call_update": {
      const toolCallId = chunk.tool_call_id
      if (!toolCallId) return items
      const id = toolItemKey(toolCallId)
      const index = items.findIndex((item) => item.id === id)
      if (index === -1) {
        return [
          ...items,
          {
            id,
            kind: "tool",
            toolCallId,
            title: chunk.title ?? null,
            status: chunk.status ?? null,
          },
        ]
      }
      const prev = items[index]
      if (prev.kind !== "tool") return items
      const title = chunk.title ?? prev.title
      // A non-terminal replay (the re-announced opening frame) must not
      // un-settle a terminal row.
      const status =
        !isTerminalToolStatus(chunk.status) && isTerminalToolStatus(prev.status)
          ? prev.status
          : (chunk.status ?? prev.status)
      if (title === prev.title && status === prev.status) return items
      return replaceItem(items, index, { ...prev, title, status })
    }
  }
}

/** The member's trailing unfinalized text item of `kind`, if any. */
function lastUnfinalizedTextItem(
  items: MemberTimelineItem[],
  kind: "message" | "thought"
): { index: number; item: MemberTextItem } | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (
      (item.kind === "message" || item.kind === "thought") &&
      item.kind === kind &&
      !item.final
    ) {
      return { index: i, item }
    }
  }
  return null
}

function replaceItem(
  items: MemberTimelineItem[],
  index: number,
  next: MemberTimelineItem
): MemberTimelineItem[] {
  const out = items.slice()
  out[index] = next
  return out
}

/** `tool:{toolCallId}` — the merge key shared by a call and its updates. */
export function toolItemKey(toolCallId: string): string {
  return `tool:${toolCallId}`
}

/**
 * Id for a not-yet-finalized item. Position-derived on purpose: a timeline
 * REBUILT from the same replay frames produces the same ids, so React keys and
 * the dedup checks agree across a rebuild.
 */
function liveItemId(items: MemberTimelineItem[]): string {
  return `live:${items.length}`
}

interface MemberTimelineStore {
  /** contextKey → member name → that member's ordered timeline. */
  byContext: Record<string, Record<string, MemberTimelineItem[]>>
  /** Consume one `member_chunk` event from connection `contextKey`. */
  applyMemberChunk: (contextKey: string, chunk: MemberChunkEvent) => void
  /** Move a connection's timelines to its new contextKey (`REKEY_CONNECTION`). */
  rekeyContext: (fromKey: string, toKey: string) => void
  /** Drop a connection's timelines (its entry was removed). */
  clearContext: (contextKey: string) => void
  /** Drop every connection's timelines (backend switch / tests). */
  clearAll: () => void
}

export const useMemberTimelineStore = create<MemberTimelineStore>((set) => ({
  byContext: {},
  applyMemberChunk: (contextKey, chunk) =>
    set((state) => {
      const members = state.byContext[contextKey]
      const items = members?.[chunk.member] ?? []
      const next = applyMemberChunkToItems(items, chunk)
      if (next === items) return state
      return {
        byContext: {
          ...state.byContext,
          [contextKey]: { ...members, [chunk.member]: next },
        },
      }
    }),
  rekeyContext: (fromKey, toKey) =>
    set((state) => {
      const from = state.byContext[fromKey]
      if (!from) return state
      const byContext = { ...state.byContext }
      delete byContext[fromKey]
      // A move never clobbers an existing entry — mirrors the connections
      // reducer's defensive rule for `REKEY_CONNECTION`.
      byContext[toKey] = state.byContext[toKey] ?? from
      return { byContext }
    }),
  clearContext: (contextKey) =>
    set((state) => {
      if (!(contextKey in state.byContext)) return state
      const byContext = { ...state.byContext }
      delete byContext[contextKey]
      return { byContext }
    }),
  clearAll: () =>
    set((state) =>
      Object.keys(state.byContext).length === 0 ? state : { byContext: {} }
    ),
}))

/** The member map for one connection, or `undefined` when none arrived yet. */
export function selectMemberTimelines(
  state: Pick<MemberTimelineStore, "byContext">,
  contextKey: string
): Record<string, MemberTimelineItem[]> | undefined {
  return state.byContext[contextKey]
}

// Backend-scoped singleton, like the other module stores: a realm's backend
// identity change must not leave another backend's member timelines behind.
registerBackendScopedStoreReset(() =>
  useMemberTimelineStore.getState().clearAll()
)
