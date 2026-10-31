import type { DelegationBinding } from "@/contexts/delegation-context"
import type { DelegationCardStatus } from "@/lib/delegation-card"
import type { DbConversationSummary } from "@/lib/types"

export function compareByChildCreatedAtDesc(
  left: DbConversationSummary,
  right: DbConversationSummary
): number {
  const leftTime = Date.parse(left.created_at) || 0
  const rightTime = Date.parse(right.created_at) || 0
  return rightTime - leftTime || right.id - left.id
}

/** Live events buffered during the request win over its older DB snapshot. */
export function mergeChildrenById(
  snapshot: readonly DbConversationSummary[],
  buffered: readonly DbConversationSummary[]
): DbConversationSummary[] {
  const byId = new Map<number, DbConversationSummary>()
  for (const child of snapshot) byId.set(child.id, child)
  for (const child of buffered) byId.set(child.id, child)
  return [...byId.values()].sort(compareByChildCreatedAtDesc)
}

/** Same persisted-status mapping as historical delegation metadata. */
export function subsessionStatus(
  child: DbConversationSummary,
  binding?: DelegationBinding,
  blocked = false
): DelegationCardStatus {
  const live = binding?.childConversationId === child.id ? binding : undefined
  if (blocked) return "waiting"
  if (live) return live.status
  switch (child.status) {
    case "in_progress":
      return "running"
    case "pending_review":
    case "completed":
      return "ok"
    case "cancelled":
      return "err"
    default:
      return "starting"
  }
}

export function subsessionPriority(status: DelegationCardStatus): number {
  if (status === "waiting") return 0
  if (status === "running" || status === "starting") return 1
  return 2
}
