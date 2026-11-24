import { describe, expect, it } from "vitest"

import {
  activeRetryIncidentView,
  activeSessionFailures,
  dismissSessionFailures,
  hasActiveRetryIncident,
  knownSessionFailureActions,
  lastUserPromptText,
  latestActiveTerminalFailure,
  mergeSessionFailures,
  mostRecentRecoveredWarning,
  resolvedSessionFailures,
  sessionFailureCategoryLabelKey,
  sessionFailureNotice,
  settleSessionFailures,
  upsertSessionFailure,
} from "./session-failures"
import type { MessageTurn, SessionFailureRecord } from "@/lib/types"

function record(
  id: string,
  revision: number,
  overrides: Partial<SessionFailureRecord> = {}
): SessionFailureRecord {
  return {
    id,
    revision,
    category: "limit",
    severity: "warning",
    title: `${id}@${revision}`,
    actions: ["retry"],
    resolved: false,
    ...overrides,
  }
}

describe("upsertSessionFailure / mergeSessionFailures", () => {
  it("accepts fresh ids and strictly higher revisions, in place", () => {
    let table = upsertSessionFailure([], record("a", 1))
    table = upsertSessionFailure(table, record("b", 1))
    table = upsertSessionFailure(table, record("a", 2, { title: "revised" }))
    expect(table).toHaveLength(2)
    expect(table.find((f) => f.id === "a")?.title).toBe("revised")
  })

  it("rejects equal and lower revisions by reference (replay-safe)", () => {
    const table = upsertSessionFailure([], record("a", 2))
    // Equal revision = verbatim replay (claude re-publishes still-active
    // failures on session/load) — must be a no-op, same reference.
    expect(upsertSessionFailure(table, record("a", 2))).toBe(table)
    expect(upsertSessionFailure(table, record("a", 1))).toBe(table)
  })

  it("adopts an equal-revision resolution a snapshot carries", () => {
    // `resolved` is client-INFERRED, so a client that missed the progress /
    // turn-end events it came from can only learn about it from a hydrating
    // snapshot — at the SAME revision, since the adapter never bumped one.
    const table = upsertSessionFailure([], record("a", 2))
    expect(table[0].resolved).toBe(false)
    const hydrated = mergeSessionFailures(table, [
      record("a", 2, { resolved: true }),
    ])
    expect(hydrated).not.toBe(table)
    expect(hydrated[0].resolved).toBe(true)
    expect(hydrated[0].revision).toBe(2)
    // Only false → true: a later replay carrying `false` cannot un-settle it.
    expect(mergeSessionFailures(hydrated, [record("a", 2)])).toBe(hydrated)
    // And a genuine recurrence still re-arms through a higher revision.
    expect(mergeSessionFailures(hydrated, [record("a", 3)])[0].resolved).toBe(
      false
    )
  })

  it("keeps the watermark on resolved entries — stale upserts cannot resurrect", () => {
    // upsert rev2 → settle (tombstone-equivalent) → delayed rev2 replay must
    // be rejected: the resolved entry retains the revision watermark.
    let table = upsertSessionFailure([], record("a", 2))
    table = settleSessionFailures(table, "all")
    expect(table[0].resolved).toBe(true)
    expect(upsertSessionFailure(table, record("a", 2))).toBe(table)
    expect(upsertSessionFailure(table, record("a", 1))).toBe(table)
    // A genuinely newer revision re-arms it.
    const rearmed = upsertSessionFailure(table, record("a", 3))
    expect(rearmed[0].resolved).toBe(false)
    expect(rearmed[0].revision).toBe(3)
  })

  it("re-arms resolved on escalation via id reuse (warning → error)", () => {
    let table = upsertSessionFailure([], record("t1:error", 1))
    table = settleSessionFailures(table, "warnings")
    table = upsertSessionFailure(
      table,
      record("t1:error", 2, { severity: "error", title: "gave up" })
    )
    expect(table).toHaveLength(1)
    expect(table[0].severity).toBe("error")
    expect(table[0].resolved).toBe(false)
  })

  it("merges snapshot batches monotonically and reports no-ops by reference", () => {
    const live = [record("a", 3), record("b", 1)]
    // Snapshot older for a, newer for b, plus an unseen c.
    const merged = mergeSessionFailures(live, [
      record("a", 2),
      record("b", 2),
      record("c", 1),
    ])
    expect(merged.find((f) => f.id === "a")?.revision).toBe(3)
    expect(merged.find((f) => f.id === "b")?.revision).toBe(2)
    expect(merged.find((f) => f.id === "c")).toBeDefined()
    // Entirely stale batch → same reference.
    expect(mergeSessionFailures(merged, [record("a", 1)])).toBe(merged)
    expect(mergeSessionFailures(merged, [])).toBe(merged)
    expect(mergeSessionFailures(merged, null)).toBe(merged)
    // Records without usable identity are skipped, not crashed on.
    expect(mergeSessionFailures(merged, [record("", 1), record("d", 0)])).toBe(
      merged
    )
  })
})

describe("settleSessionFailures", () => {
  it("settles warnings only at turn boundaries; errors survive", () => {
    const table = [record("w", 1), record("e", 1, { severity: "error" })]
    const settled = settleSessionFailures(table, "warnings")
    expect(settled.find((f) => f.id === "w")?.resolved).toBe(true)
    expect(settled.find((f) => f.id === "e")?.resolved).toBe(false)
    // New prompt settles everything.
    const all = settleSessionFailures(settled, "all")
    expect(all.every((f) => f.resolved)).toBe(true)
  })

  it("is a reference-preserving no-op when nothing needs settling", () => {
    const table = settleSessionFailures([record("w", 1)], "all")
    expect(settleSessionFailures(table, "all")).toBe(table)
    expect(settleSessionFailures([], "warnings")).toEqual([])
  })

  it("settles retry incidents on turn progress, sparing notices and errors", () => {
    const table = [
      record("conn", 1, { category: "connection" }),
      record("svc", 1, { category: "service" }),
      // Non-incident informational records (codex config/skill-budget
      // notices, claude advisories) — they must survive to the turn boundary.
      record("notice", 1, { category: "unknown" }),
      record("err", 1, { category: "connection", severity: "error" }),
    ]
    const settled = settleSessionFailures(table, "retry_incidents")
    expect(settled.find((f) => f.id === "conn")?.resolved).toBe(true)
    expect(settled.find((f) => f.id === "svc")?.resolved).toBe(true)
    expect(settled.find((f) => f.id === "notice")?.resolved).toBe(false)
    expect(settled.find((f) => f.id === "err")?.resolved).toBe(false)
    // The clean turn end still sweeps the notice that progress spared.
    const atTurnEnd = settleSessionFailures(settled, "warnings")
    expect(atTurnEnd.find((f) => f.id === "notice")?.resolved).toBe(true)
    expect(atTurnEnd.find((f) => f.id === "err")?.resolved).toBe(false)
  })
})

describe("hasActiveRetryIncident", () => {
  it("is true only for an unresolved non-'unknown' warning", () => {
    expect(hasActiveRetryIncident([])).toBe(false)
    expect(
      hasActiveRetryIncident([record("n", 1, { category: "unknown" })])
    ).toBe(false)
    expect(
      hasActiveRetryIncident([record("e", 1, { severity: "error" })])
    ).toBe(false)
    expect(
      hasActiveRetryIncident([
        record("c", 1, { category: "connection", resolved: true }),
      ])
    ).toBe(false)
    expect(
      hasActiveRetryIncident([record("c", 1, { category: "connection" })])
    ).toBe(true)
  })
})

describe("dismissSessionFailures", () => {
  it("resolves just those ids and keeps them as watermarks", () => {
    const table = [record("a", 2), record("b", 1)]
    const next = dismissSessionFailures(table, ["a"])
    expect(next.find((f) => f.id === "a")?.resolved).toBe(true)
    expect(next.find((f) => f.id === "b")?.resolved).toBe(false)
    // Watermark retained: a stale re-publish at the same revision is rejected,
    // a genuine recurrence at a higher revision re-arms the strip.
    expect(upsertSessionFailure(next, record("a", 2))).toBe(next)
    const rearmed = upsertSessionFailure(next, record("a", 3)).find(
      (f) => f.id === "a"
    )
    expect(rearmed?.resolved).toBe(false)
    expect(rearmed?.dismissed).toBeUndefined()
  })

  it("closes every id one collapsed strip stood for", () => {
    const table = [record("w1", 1), record("w2", 1), record("w3", 1)]
    const next = dismissSessionFailures(table, ["w1", "w2", "w3"])
    expect(next.every((f) => f.resolved && f.dismissed)).toBe(true)
    expect(activeRetryIncidentView(next).incident).toBeNull()
  })

  it("marks dismissal distinctly so it never renders as recovery", () => {
    const table = dismissSessionFailures([record("w", 1)], ["w"])
    expect(table[0].dismissed).toBe(true)
    // Resolved, but NOT a recovery — closing a strip must leave nothing behind.
    expect(resolvedSessionFailures(table)).toHaveLength(1)
    expect(mostRecentRecoveredWarning(table)).toBeNull()
  })

  it("silences an ALREADY-RESOLVED record — that is the recovered line's exit", () => {
    // Regression: gating on `!resolved` made the recovered strip's close
    // button and auto-expiry silent no-ops, so it hung under the composer
    // forever (field report 2026-08-17).
    const table = [record("a", 1, { resolved: true })]
    const next = dismissSessionFailures(table, ["a"])
    expect(next).not.toBe(table)
    expect(next[0]).toMatchObject({ resolved: true, dismissed: true })
    expect(mostRecentRecoveredWarning(next)).toBeNull()
  })

  it("is a reference-preserving no-op for unknown / already-dismissed ids", () => {
    const table = [
      record("a", 1, { resolved: true, dismissed: true }),
      record("b", 1),
    ]
    expect(dismissSessionFailures(table, ["a"])).toBe(table)
    expect(dismissSessionFailures(table, ["nope"])).toBe(table)
    expect(dismissSessionFailures(table, [])).toBe(table)
  })

  it("survives a backend snapshot that never saw the dismissal", () => {
    const dismissed = dismissSessionFailures([record("w", 1)], ["w"])
    // The backend still has it unresolved at the same revision: a replay must
    // not un-silence it.
    const hydrated = mergeSessionFailures(dismissed, [
      record("w", 1, { resolved: false }),
    ])
    expect(hydrated).toBe(dismissed)
    expect(activeSessionFailures(hydrated)).toHaveLength(0)
  })
})

describe("mostRecentRecoveredWarning", () => {
  it("picks the latest self-settled warning, ignoring errors and dismissals", () => {
    const table = [
      record("w1", 1, { resolved: true }),
      record("w2", 1, { resolved: true }),
      record("e1", 1, { severity: "error", resolved: true }),
      record("w3", 1),
    ]
    expect(mostRecentRecoveredWarning(table)?.id).toBe("w2")
    // Closing the line on screen falls back to the older genuine recovery,
    // never to the record just silenced.
    const afterDismiss = dismissSessionFailures(table, ["w2"])
    expect(mostRecentRecoveredWarning(afterDismiss)?.id).toBe("w1")
    // …and with that one silenced too, nothing is left to announce.
    expect(
      mostRecentRecoveredWarning(dismissSessionFailures(afterDismiss, ["w1"]))
    ).toBeNull()
  })

  it("returns null when there is nothing recovered", () => {
    expect(mostRecentRecoveredWarning([])).toBeNull()
    expect(mostRecentRecoveredWarning([record("w", 1)])).toBeNull()
  })

  it("never announces an advisory the turn end merely swept as 'recovered'", () => {
    // Category "unknown" is the advisory lane (config notices, model-fallback
    // notes). A clean turn end settles it, but nothing was broken, so the
    // muted "Recovered · …" line must not claim a fix for it.
    const advisory = record("adv", 1, { category: "unknown", resolved: true })
    expect(mostRecentRecoveredWarning([advisory])).toBeNull()
    // A genuine incident behind it still gets its line.
    const incident = record("inc", 1, {
      category: "connection",
      resolved: true,
    })
    expect(mostRecentRecoveredWarning([incident, advisory])?.id).toBe("inc")
  })
})

describe("latestActiveTerminalFailure", () => {
  it("finds the latest unresolved non-warning record, or null", () => {
    expect(latestActiveTerminalFailure([])).toBeNull()
    expect(latestActiveTerminalFailure([record("w", 1)])).toBeNull()
    expect(
      latestActiveTerminalFailure([
        record("e", 1, { severity: "error", resolved: true }),
      ])
    ).toBeNull()
    expect(
      latestActiveTerminalFailure([
        record("e1", 1, { severity: "error" }),
        record("e2", 1, { severity: "error" }),
        record("w", 1),
      ])?.id
    ).toBe("e2")
    // An unrecognized severity is terminal, like the notification treats it.
    expect(
      latestActiveTerminalFailure([record("x", 1, { severity: "fatal" })])?.id
    ).toBe("x")
  })
})

describe("activeRetryIncidentView", () => {
  it("collapses active incidents to the latest plus a count", () => {
    const view = activeRetryIncidentView([
      record("w1", 1),
      record("w2", 1),
      record("w3", 1),
      record("gone", 1, { resolved: true }),
    ])
    expect(view.incident?.id).toBe("w3")
    expect(view.hiddenCount).toBe(2)
    expect(view.ids).toEqual(["w1", "w2", "w3"])
  })

  it("leaves out what is news rather than progress", () => {
    // Terminal failures and category-"unknown" advisories are notifications.
    const view = activeRetryIncidentView([
      record("e", 1, { severity: "error" }),
      record("advisory", 1, { category: "unknown" }),
      record("w", 1),
    ])
    expect(view.incident?.id).toBe("w")
    expect(view.hiddenCount).toBe(0)
    expect(view.ids).toEqual(["w"])
  })

  it("reports an empty view when nothing is in flight", () => {
    expect(
      activeRetryIncidentView([
        record("w", 1, { resolved: true }),
        record("e", 1, { severity: "error" }),
      ])
    ).toEqual({ incident: null, hiddenCount: 0, ids: [] })
  })
})

describe("sessionFailureNotice", () => {
  const terminal = (overrides: Partial<SessionFailureRecord> = {}) =>
    record("t", 1, { severity: "error", category: "access", ...overrides })
  const advisory = (overrides: Partial<SessionFailureRecord> = {}) =>
    record("a", 1, { category: "unknown", actions: [], ...overrides })

  it("tells a new terminal failure and a new advisory", () => {
    expect(sessionFailureNotice(undefined, terminal())).toBe("terminal")
    expect(sessionFailureNotice(undefined, advisory())).toBe("advisory")
    // An unrecognized severity is terminal.
    expect(
      sessionFailureNotice(undefined, terminal({ severity: "fatal" }))
    ).toBe("terminal")
  })

  it("never tells a retry incident — the dock draws that one live", () => {
    expect(sessionFailureNotice(undefined, record("w", 1))).toBeNull()
    expect(
      sessionFailureNotice(record("w", 1), record("w", 2, { title: "again" }))
    ).toBeNull()
  })

  it("tells an incident the adapter escalated to a terminal failure", () => {
    // codex reuses the id with a bumped revision: warning → error.
    expect(
      sessionFailureNotice(
        record("x", 1),
        record("x", 2, { severity: "error" })
      )
    ).toBe("terminal")
  })

  it("stays quiet for stale and replayed revisions", () => {
    expect(
      sessionFailureNotice(terminal({ revision: 2 }), terminal())
    ).toBeNull()
    expect(sessionFailureNotice(terminal(), terminal())).toBeNull()
    expect(
      sessionFailureNotice(undefined, terminal({ id: "", revision: 1 }))
    ).toBeNull()
    expect(
      sessionFailureNotice(undefined, terminal({ revision: 0 }))
    ).toBeNull()
  })

  it("stays quiet for a re-publish that changes nothing on screen", () => {
    // Adapters bump revisions to re-publish; the same active wording is not
    // news a second time.
    expect(
      sessionFailureNotice(advisory(), advisory({ revision: 2 }))
    ).toBeNull()
    expect(
      sessionFailureNotice(terminal(), terminal({ revision: 2 }))
    ).toBeNull()
  })

  it("tells a revision that says something new", () => {
    expect(
      sessionFailureNotice(
        advisory(),
        advisory({ revision: 2, title: "Different" })
      )
    ).toBe("advisory")
    expect(
      sessionFailureNotice(
        terminal(),
        terminal({ revision: 2, details: "now with a reason" })
      )
    ).toBe("terminal")
    expect(
      sessionFailureNotice(
        terminal({ actions: ["login"] }),
        terminal({ revision: 2, actions: ["login", "retry"] })
      )
    ).toBe("terminal")
  })

  it("tells the same wording again once it was settled — a new occurrence", () => {
    expect(
      sessionFailureNotice(
        advisory({ resolved: true }),
        advisory({ revision: 2 })
      )
    ).toBe("advisory")
    expect(
      sessionFailureNotice(
        terminal({ resolved: true }),
        terminal({ revision: 2 })
      )
    ).toBe("terminal")
  })
})

describe("sessionFailureCategoryLabelKey", () => {
  it("names each known category and folds the rest onto unknown", () => {
    expect(sessionFailureCategoryLabelKey("connection")).toBe(
      "category.connection"
    )
    expect(sessionFailureCategoryLabelKey("access")).toBe("category.access")
    expect(sessionFailureCategoryLabelKey("limit")).toBe("category.limit")
    expect(sessionFailureCategoryLabelKey("request")).toBe("category.request")
    expect(sessionFailureCategoryLabelKey("service")).toBe("category.service")
    expect(sessionFailureCategoryLabelKey("unknown")).toBe("category.unknown")
    expect(sessionFailureCategoryLabelKey("_vendor")).toBe("category.unknown")
  })
})

describe("lastUserPromptText", () => {
  function turn(
    role: MessageTurn["role"],
    blocks: MessageTurn["blocks"]
  ): MessageTurn {
    return { id: `${role}-${Math.random()}`, role, blocks, timestamp: "" }
  }
  const text = (t: string) => ({ type: "text", text: t }) as const
  const image = {
    type: "image",
    data: "aGk=",
    mime_type: "image/png",
    uri: null,
  } as const

  it("returns the MOST RECENT user turn's joined text", () => {
    const turns = [
      turn("user", [text("first prompt")]),
      turn("assistant", [text("reply")]),
      turn("user", [text("line one"), image, text("line two")]),
      turn("assistant", [text("failed mid-way")]),
    ]
    expect(lastUserPromptText(turns)).toBe("line one\nline two")
  })

  it("skips image-only and blank user turns, and handles no-user/undefined", () => {
    // The retry action must resend something MEANINGFUL: an image-only or
    // whitespace user turn yields nothing, so the scan continues backwards.
    const turns = [
      turn("user", [text("real prompt")]),
      turn("user", [image]),
      turn("user", [text("   ")]),
    ]
    expect(lastUserPromptText(turns)).toBe("real prompt")
    expect(lastUserPromptText([turn("assistant", [text("only agent")])])).toBe(
      null
    )
    expect(lastUserPromptText([])).toBe(null)
    expect(lastUserPromptText(undefined)).toBe(null)
  })
})

describe("selectors", () => {
  it("splits active from resolved and filters renderable actions", () => {
    const table = [
      record("w", 1, { resolved: true }),
      record("e", 1, {
        severity: "error",
        actions: ["login", "sing", "retry"],
      }),
    ]
    expect(activeSessionFailures(table).map((f) => f.id)).toEqual(["e"])
    expect(resolvedSessionFailures(table).map((f) => f.id)).toEqual(["w"])
    // Order follows the known vocabulary, unknown entries dropped.
    expect(knownSessionFailureActions(table[1])).toEqual(["retry", "login"])
    expect(
      knownSessionFailureActions(record("x", 1, { actions: undefined }))
    ).toEqual([])
  })
})
