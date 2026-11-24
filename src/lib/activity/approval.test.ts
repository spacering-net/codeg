import { describe, expect, it } from "vitest"

import type { ToolApprovalInfo } from "@/lib/types"
import {
  approvalFromInfo,
  approvalFromMeta,
  EMPTY_TOOL_APPROVALS,
  mergeToolApprovals,
} from "./approval"

function info(
  toolCallId: string,
  optionKind: string,
  decidedAt = "2026-10-22T09:00:00Z"
): ToolApprovalInfo {
  return {
    tool_call_id: toolCallId,
    option_kind: optionKind,
    option_name: "Allow",
    origin: "user",
    decided_at: decidedAt,
  }
}

describe("approvalFromMeta", () => {
  it("reads the stamp a detail load puts on a tool call", () => {
    expect(
      approvalFromMeta({
        "codeg.delegation": { status: "completed" },
        "codeg.approval": {
          option_kind: "allow_always",
          option_name: "Always Allow",
          origin: "chat_channel",
          decided_at: "2026-10-22T09:41:12Z",
        },
      })
    ).toEqual({
      decision: "allowAlways",
      optionName: "Always Allow",
      origin: "chat_channel",
      decidedAt: "2026-10-22T09:41:12Z",
    })
  })

  it("folds both rejection kinds into one decision", () => {
    for (const kind of ["reject_once", "reject_always"]) {
      expect(
        approvalFromMeta({ "codeg.approval": { option_kind: kind } })?.decision
      ).toBe("rejected")
    }
  })

  it("ignores a missing, malformed or unknown stamp", () => {
    expect(approvalFromMeta(null)).toBeNull()
    expect(approvalFromMeta({})).toBeNull()
    expect(approvalFromMeta({ "codeg.approval": "allow_once" })).toBeNull()
    expect(
      approvalFromMeta({ "codeg.approval": { option_kind: "maybe_later" } })
    ).toBeNull()
  })
})

describe("approvalFromInfo", () => {
  it("keeps one object per record, so rows keep their props", () => {
    const record = info("tc-1", "allow_once")
    const approval = approvalFromInfo(record)
    expect(approval?.decision).toBe("allowOnce")
    expect(approvalFromInfo(record)).toBe(approval)
  })
})

describe("mergeToolApprovals", () => {
  it("keeps one record per call, the later decision winning", () => {
    const first = info("tc-1", "allow_once", "2026-10-22T09:00:00Z")
    const later = info("tc-1", "reject_once", "2026-10-22T09:05:00Z")
    const other = info("tc-2", "allow_always")
    const merged = mergeToolApprovals(EMPTY_TOOL_APPROVALS, [
      first,
      other,
      later,
    ])
    expect(merged).toEqual({ "tc-1": later, "tc-2": other })
    // An older record arriving afterwards cannot walk it back.
    expect(mergeToolApprovals(merged, [first])).toBe(merged)
  })

  it("returns the map itself when nothing changes", () => {
    const record = info("tc-1", "allow_once")
    const merged = mergeToolApprovals(EMPTY_TOOL_APPROVALS, [record])
    expect(mergeToolApprovals(merged, [record])).toBe(merged)
    expect(mergeToolApprovals(merged, [])).toBe(merged)
    expect(mergeToolApprovals(merged, undefined)).toBe(merged)
  })
})
