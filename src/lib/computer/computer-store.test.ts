import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(() => Promise.resolve(() => {})),
}))
vi.mock("./computer-api", () => ({
  computerAvailable: () => false,
  askComputerServed: () => Promise.resolve(false),
  subscribeComputerServed: () => () => {},
}))

import {
  clearComputerActivity,
  computerStoreMark,
  recordComputerActivity,
  resetComputerStoreForTest,
  setComputerShared,
  setComputerSharedSince,
  setComputerStateSince,
  useComputerStore,
} from "./computer-store"
import { act, renderHook } from "@testing-library/react"

beforeEach(() => resetComputerStoreForTest())

function state() {
  return renderHook(() => useComputerStore()).result.current
}

describe("computer store", () => {
  /** A run of the same attempt on the same window is one line with a count;
   * anything else starts a new line on top. */
  it("collapses runs of the same attempt and keeps the rest apart", () => {
    const at = 1_000
    recordComputerActivity({
      targetId: "w1",
      action: "capture",
      outcome: "done",
      at,
    })
    recordComputerActivity({
      targetId: "w1",
      action: "capture",
      outcome: "done",
      at: at + 1,
    })
    recordComputerActivity({
      targetId: "w2",
      action: "capture",
      outcome: "done",
      at: at + 2,
    })
    recordComputerActivity({
      targetId: "w2",
      action: "capture",
      outcome: "refused",
      at: at + 3,
    })

    const lines = state().activity
    expect(lines.map((l) => [l.targetId, l.outcome, l.count])).toEqual([
      ["w2", "refused", 1],
      ["w2", "done", 1],
      ["w1", "done", 2],
    ])
    // The collapsed line carries the time of the latest attempt.
    expect(lines[2].at).toBe(at + 1)
  })

  it("keeps a bounded history", () => {
    for (let i = 0; i < 80; i++) {
      recordComputerActivity({
        targetId: `w${i}`,
        action: "snapshot",
        outcome: "done",
        at: i,
      })
    }
    const lines = state().activity
    expect(lines).toHaveLength(50)
    expect(lines[0].targetId).toBe("w79")
  })

  /** Cleared, the list starts over: the next attempt is a line of its own,
   * not one more on the count of a line that is gone. */
  it("starts over once cleared", () => {
    const attempt = {
      targetId: "w1",
      action: "capture",
      outcome: "done",
    } as const
    recordComputerActivity({ ...attempt, at: 1 })
    recordComputerActivity({ ...attempt, at: 2 })
    clearComputerActivity()
    expect(state().activity).toEqual([])

    act(() => recordComputerActivity({ ...attempt, at: 3 }))
    expect(state().activity.map((l) => [l.targetId, l.count, l.at])).toEqual([
      ["w1", 1, 3],
    ])
  })

  it("takes the shared list as given", () => {
    setComputerShared([
      {
        targetId: "w1",
        appName: "TextEdit",
        appKey: "com.apple.TextEdit",
        title: "notes",
        level: "read",
        grantedAt: 1,
        lastUsedAt: 2,
      },
    ])
    expect(state().shared.map((w) => w.targetId)).toEqual(["w1"])
  })

  /** A fetched list is only as new as the moment the fetch began: an event
   * that landed since is newer, and wins. */
  /** The applications shared as a whole come with the state; a window's own
   * share, which answers with its windows alone, leaves them as they were. */
  it("keeps the shared applications until the state says otherwise", () => {
    const app = {
      appId: "a1",
      appName: "Mail",
      appKey: "com.apple.mail",
      level: "read" as const,
      grantedAt: 1,
      lastUsedAt: 1,
      windows: 0,
    }
    act(() =>
      setComputerStateSince({ shared: [], apps: [app] }, computerStoreMark())
    )
    expect(state().sharedApps).toEqual([app])
    act(() => setComputerShared([]))
    expect(state().sharedApps).toEqual([app])
    act(() => setComputerStateSince({ shared: [] }, computerStoreMark()))
    expect(state().sharedApps).toEqual([])
  })

  it("drops a fetched list an event has overtaken", () => {
    const window = (targetId: string) => ({
      targetId,
      appName: "TextEdit",
      appKey: "com.apple.TextEdit",
      title: "",
      level: "read" as const,
      grantedAt: 1,
      lastUsedAt: 1,
    })
    const mark = computerStoreMark()
    setComputerShared([window("w2")])
    setComputerSharedSince([], mark)
    expect(state().shared.map((w) => w.targetId)).toEqual(["w2"])

    setComputerSharedSince([window("w3")], computerStoreMark())
    expect(state().shared.map((w) => w.targetId)).toEqual(["w3"])
  })
})
