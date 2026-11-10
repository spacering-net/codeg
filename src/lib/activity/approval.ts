import type { ToolApprovalInfo } from "@/lib/types"

/**
 * How a tool call's permission request was answered, as the transcript draws
 * it: a chip on the call's row. Built from the live `tool_approval` record
 * (the connection's own) or from the `meta["codeg.approval"]` stamp a reopened
 * conversation's detail load puts on the call.
 */
export interface ToolApproval {
  decision: ApprovalDecision
  /** The chosen option's label in the agent's own words ("Always Allow",
   *  "Yes, and don't ask again for git commands"). */
  optionName: string | null
  /** `user`, `chat_channel`, `cli_policy`; anything else reads as unknown. */
  origin: string | null
  /** ISO timestamp. */
  decidedAt: string | null
}

/**
 * `allow_once` / `allow_always` / a rejection. ACP has `reject_once` and
 * `reject_always`; both turned this call away, which is what the row says.
 */
export type ApprovalDecision = "allowOnce" | "allowAlways" | "rejected"

/** Where a detail load stamps a call's approval (Rust `APPROVAL_META_KEY`). */
const APPROVAL_META_KEY = "codeg.approval"

function decisionOf(kind: unknown): ApprovalDecision | null {
  switch (kind) {
    case "allow_once":
      return "allowOnce"
    case "allow_always":
      return "allowAlways"
    case "reject_once":
    case "reject_always":
      return "rejected"
    default:
      return null
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

function fromFields(fields: Record<string, unknown>): ToolApproval | null {
  const decision = decisionOf(fields.option_kind)
  if (!decision) return null
  return {
    decision,
    optionName: text(fields.option_name),
    origin: text(fields.origin),
    decidedAt: text(fields.decided_at),
  }
}

/** The approval a detail load stamped on a tool call's `meta`, if any. */
export function approvalFromMeta(
  meta: Record<string, unknown> | null | undefined
): ToolApproval | null {
  const stamp = meta?.[APPROVAL_META_KEY]
  if (!stamp || typeof stamp !== "object" || Array.isArray(stamp)) return null
  return fromFields(stamp as Record<string, unknown>)
}

const fromInfoCache = new WeakMap<ToolApprovalInfo, ToolApproval | null>()

/** A live record as the transcript draws it. Cached per record object, so a
 *  row's approval keeps its identity across renders. */
export function approvalFromInfo(info: ToolApprovalInfo): ToolApproval | null {
  if (fromInfoCache.has(info)) return fromInfoCache.get(info) ?? null
  const approval = fromFields(info as unknown as Record<string, unknown>)
  fromInfoCache.set(info, approval)
  return approval
}

/** A connection's approval records, by tool call id. */
export type ToolApprovalMap = Readonly<Record<string, ToolApprovalInfo>>

export const EMPTY_TOOL_APPROVALS: ToolApprovalMap = Object.freeze({})

function decidedAtMs(info: ToolApprovalInfo): number {
  const ms = Date.parse(info.decided_at)
  return Number.isNaN(ms) ? 0 : ms
}

/**
 * Fold records into a connection's map: one per tool call, the later decision
 * winning. Idempotent and order-free, so a snapshot older than the events
 * already applied can only add calls this client never saw answered, never
 * walk one back. Returns `current` itself when nothing changed.
 */
export function mergeToolApprovals(
  current: ToolApprovalMap,
  incoming: readonly ToolApprovalInfo[] | null | undefined
): ToolApprovalMap {
  if (!incoming || incoming.length === 0) return current
  let next: Record<string, ToolApprovalInfo> | null = null
  for (const info of incoming) {
    if (!info || typeof info.tool_call_id !== "string") continue
    const known = (next ?? current)[info.tool_call_id]
    if (known && decidedAtMs(known) >= decidedAtMs(info)) continue
    next ??= { ...current }
    next[info.tool_call_id] = info
  }
  return next ?? current
}
