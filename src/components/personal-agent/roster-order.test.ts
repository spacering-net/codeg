import { describe, expect, it } from "vitest"

import type { BotLive, RosterEntry } from "@/lib/types"

import {
  groupRoster,
  rosterOrder,
  sectionNames,
  STUCK_AFTER_MS,
  tierOf,
  viewOf,
} from "./roster-order"

const NOW = Date.parse("2026-11-10T12:00:00Z")
const at = (ms: number) => new Date(NOW + ms).toISOString()

function live(patch: Partial<BotLive> = {}): BotLive {
  return {
    bot_id: 1,
    work: "done",
    attention: "none",
    needs: null,
    unread: 0,
    activity: null,
    activity_known: true,
    work_on_hand: [],
    awaiting: [],
    face: "idle",
    flash: null,
    connected: true,
    last_line: null,
    last_activity_at: null,
    updated_at: at(-1000),
    expires_at: null,
    ...patch,
  }
}

function entry(
  id: number,
  patch: Partial<BotLive> = {},
  roster: Partial<RosterEntry["roster"]> = {},
  kind: "primary" | "worker" = "worker"
): RosterEntry {
  return {
    id,
    kind,
    uid: `u${id}`,
    name: `Bot ${id}`,
    avatar: { kind: "face", shape: "blob", color: "teal" },
    template: null,
    executor_assistant_id: null,
    created_at: at(-86_400_000),
    roster: {
      sort_order: 0,
      pinned_at: null,
      section: null,
      hidden: false,
      muted: false,
      unread_mark: false,
      notify: true,
      ...roster,
    },
    live: live({ bot_id: id, ...patch }),
  }
}

describe("how an assistant looks", () => {
  it("shows a face just done for its few seconds, then the one at rest", () => {
    const l = live({
      face: "sleeping",
      flash: { face: "done", until: at(5000) },
    })
    expect(viewOf(l, NOW).look).toBe("done")
    expect(viewOf(l, NOW + 6000).look).toBe("sleeping")
  })

  it("takes a busy state not renewed by its expiry as at rest", () => {
    const l = live({
      work: "busy",
      face: "working",
      expires_at: at(30_000),
    })
    expect(viewOf(l, NOW)).toMatchObject({
      look: "working",
      busy: true,
      stale: false,
    })
    expect(viewOf(l, NOW + 30_000)).toMatchObject({
      look: "idle",
      busy: false,
      stale: true,
    })
  })

  it("waits, then drowses past two minutes of waiting, with an orange dot", () => {
    const l = live({
      attention: "needs_you",
      face: "waiting",
      needs: {
        kind: "question",
        text: "A or B?",
        since: at(0),
        row_id: 4,
        count: 1,
      },
    })
    expect(viewOf(l, NOW)).toMatchObject({ look: "waiting", dot: "waiting" })
    expect(viewOf(l, NOW + STUCK_AFTER_MS).look).toBe("stuck")
  })

  it("has a blue dot when something is unseen or the owner marked it", () => {
    expect(viewOf(live({ attention: "unread", unread: 2 }), NOW).dot).toBe(
      "unread"
    )
    expect(viewOf(live(), NOW, true).dot).toBe("unread")
    expect(viewOf(live(), NOW).dot).toBeNull()
  })
})

describe("the roster's order", () => {
  it("puts the waiting first, then the working, the idle, the done — the latest first in each", () => {
    const done = entry(2, { work: "done", last_activity_at: at(-10) })
    const idleOld = entry(3, { work: "idle", last_activity_at: at(-5000) })
    const idleNew = entry(4, { work: "idle", last_activity_at: at(-100) })
    const busy = entry(5, { work: "busy", expires_at: at(30_000) })
    const waiting = entry(6, { attention: "needs_you" })
    const order = rosterOrder(
      [done, idleOld, idleNew, busy, waiting, entry(1, {}, {}, "primary")],
      NOW
    )
    expect(order.map((e) => e.id)).toEqual([1, 6, 5, 4, 3, 2])
    expect(tierOf(busy.live, NOW + 31_000)).toBe(2)
  })

  it("puts the pinned under the primary in the owner's order, then the groups by name, then the rest", () => {
    const g = groupRoster(
      [
        entry(1, {}, {}, "primary"),
        entry(2, {}, { pinned_at: at(-50), sort_order: 1 }),
        entry(3, {}, { pinned_at: at(-10), sort_order: 0 }),
        entry(4, {}, { section: "my-app" }),
        entry(5, {}, { section: "codeg" }),
        entry(6),
        entry(7, {}, { hidden: true }),
        entry(8, {}, { hidden: true, pinned_at: at(0) }),
      ],
      NOW
    )
    expect(g.primary?.id).toBe(1)
    expect(g.pinned.map((e) => e.id)).toEqual([3, 2])
    expect(g.sections.map((s) => s.name)).toEqual(["codeg", "my-app"])
    expect(g.rest.map((e) => e.id)).toEqual([6])
    expect(g.hidden.map((e) => e.id).sort()).toEqual([7, 8])
    expect(
      rosterOrder(
        [entry(9, {}, { hidden: true }), entry(1, {}, {}, "primary"), entry(2)],
        NOW
      ).map((e) => e.id)
    ).toEqual([1, 2])
  })

  it("offers the groups the owner made, once each", () => {
    expect(
      sectionNames([
        entry(2, {}, { section: "b" }),
        entry(3, {}, { section: " a " }),
        entry(4, {}, { section: "b" }),
        entry(5),
      ])
    ).toEqual(["a", "b"])
  })
})
