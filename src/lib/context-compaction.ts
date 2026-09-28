/**
 * Context-compaction tool-call detection.
 *
 * A context-compaction lifecycle arrives as an ACP `tool_call` whose
 * `_meta.contextCompaction` takes one of two shapes:
 *
 * - the legacy boolean marker `true` — codex-acp 1.1.3–1.2.x (#288) and the
 *   Grok bridge's `auto_compact_completed` synthesis (live via `connection.rs`,
 *   historical via `parsers/grok.rs`), which stamps sibling top-level
 *   `tokensBefore`/`tokensAfter` counts next to the marker;
 * - the versioned object `{version: 1, …}` — codex-acp 1.3.0+ (#396), whose
 *   schema reserves optional `trigger`, `preTokens`, `postTokens`, `durationMs`
 *   and `error` fields (1.3.0 itself emits the bare `{version: 1}`);
 *   deepseek-acp fills them from its `compaction/start`+`end` pair, and
 *   claude-agent-acp 0.75.0+ (#991) is the first to fill ALL of them, live and
 *   in history alike (`parsers/claude.rs` synthesizes the same pair from the
 *   transcript's `system`/`compact_boundary` record).
 *
 * BOTH shapes stay accepted long-term: the Grok bridge keeps emitting the
 * boolean. Because recognition is by `_meta` key and NOT by agent, an adapter
 * that adopts the convention lights the card up with no wiring — which is
 * exactly what claude 0.75.0 did. Matching renders through the dedicated
 * `<ContextCompactionCard>` (a subtle status row, not the generic tool shell)
 * and must NOT fold into a "调用 N 个工具" tool-group.
 *
 * Kept in a dependency-free module so both the grouping pass
 * (`ai-elements-adapter.ts`) and the card/renderer can share it without an
 * import cycle (the card re-exports `ToolCallState` from the adapter).
 */
export function isContextCompactionMeta(meta: unknown): boolean {
  if (!meta || typeof meta !== "object") return false
  const marker = (meta as Record<string, unknown>).contextCompaction
  if (marker === true) return true
  if (!marker || typeof marker !== "object") return false
  const version = (marker as Record<string, unknown>).version
  return (
    typeof version === "number" && Number.isInteger(version) && version >= 1
  )
}

/**
 * `_meta` key with which the backend claims a compaction call's output IS its
 * retained summary. The Rust twin (`COMPACTION_SUMMARY_META_KEY` in
 * `acp/connection.rs`) is stamped only by the reader that translates the ACP
 * `compaction_update` / `compaction_summary_chunk` lifecycle, whose summary
 * streams on the call's `raw_output`.
 */
export const COMPACTION_SUMMARY_META_KEY = "codeg.compactionSummary"

/**
 * The retained summary a compaction call carries, or `null`.
 *
 * Requires the backend's explicit claim rather than trusting any output: the
 * LEGACY compaction call puts other things on the same channel (claude's parks
 * its `{trigger, preTokens, …}` metadata object there), and a history divider
 * never has a summary at all — claude's lives in the separate continuation
 * turn the parser emits beneath it.
 */
export function contextCompactionSummary(
  meta: unknown,
  output: string | null | undefined
): string | null {
  if (!isContextCompactionMeta(meta)) return null
  if ((meta as Record<string, unknown>)[COMPACTION_SUMMARY_META_KEY] !== true) {
    return null
  }
  return typeof output === "string" && output.trim().length > 0 ? output : null
}

/**
 * The versioned `_meta.contextCompaction` payload (codex-acp 1.3.0+), or
 * `null` for the boolean-marker shape and for non-compaction meta. Callers
 * read individual fields leniently — the schema only reserves them, and every
 * one may be absent.
 */
export function contextCompactionPayload(
  meta: unknown
): Record<string, unknown> | null {
  if (!isContextCompactionMeta(meta)) return null
  const marker = (meta as Record<string, unknown>).contextCompaction
  return marker && typeof marker === "object"
    ? (marker as Record<string, unknown>)
    : null
}
