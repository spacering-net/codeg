import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  subscribe: vi.fn(),
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: mocks.call, subscribe: mocks.subscribe }),
}))

import { createHarnessSlotStore } from "@/lib/harness-slots"
import { HarnessClientError } from "./errors"
import {
  CHECKING_REREAD_MS,
  CHECK_FRESH_MS,
  HARNESS_UPDATES,
  HARNESS_UPDATES_CHANGED_EVENT,
  checkHarnessUpdates,
  checkIsStale,
  harnessCheckUpdates,
  harnessUpdates,
  normalizeHarnessUpdates,
  normalizeUpdatesChanged,
  onHarnessUpdatesChanged,
  reloadHarnessUpdates,
  remoteFor,
  remoteStateOf,
  updatesById,
  type HarnessUpdateItem,
} from "./updates"

function rawUpdates(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    checking: false,
    checked_at: "2026-11-17T09:00:00.000Z",
    attempted_at: "2026-11-17T09:00:00.000Z",
    error: null,
    items: [
      {
        id: "item-a",
        revision: 1,
        state: "update_available",
        update_available: true,
        latest: { revision: 3, version: "3.0.0" },
        ref: "acme/a",
      },
      {
        id: "item-b",
        revision: 2,
        state: "latest",
        update_available: false,
        latest: { revision: 2, version: null },
        ref: "acme/b",
      },
    ],
    count: 1,
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  mocks.call.mockReset()
  mocks.subscribe.mockReset()
})

describe("the answers", () => {
  it("reads each state, the update and why a state is unknown", () => {
    const value = normalizeHarnessUpdates(
      rawUpdates({
        items: [
          ...rawUpdates().items,
          {
            id: "item-c",
            revision: 1,
            state: "yanked",
            update_available: true,
            latest: { revision: 2, version: "2.0.0" },
            ref: null,
          },
          { id: "item-d", revision: 4, state: "disabled_by_author" },
          { id: "item-e", revision: 4, state: "removed_by_harness" },
          {
            id: "item-f",
            revision: 1,
            state: "unknown",
            unknown: "unavailable",
          },
          { id: "item-g", revision: 1, state: "unknown" },
          // a state this build does not know says nothing
          { id: "item-h", revision: 1, state: "quarantined" },
          // no longer on SRN: not "cannot be checked"
          { id: "item-i", revision: 2, state: "gone", unknown: "unavailable" },
        ],
      })
    )
    expect(value.items.map((item) => [item.id, item.state])).toEqual([
      ["item-a", "update_available"],
      ["item-b", "latest"],
      ["item-c", "yanked"],
      ["item-d", "disabled_by_author"],
      ["item-e", "removed_by_harness"],
      ["item-f", "unknown"],
      ["item-g", "unknown"],
      ["item-h", "unknown"],
      ["item-i", "gone"],
    ])
    expect(value.items[8].unknown).toBeNull()
    expect(value.items[8].update_available).toBe(false)
    expect(value.items[5].unknown).toBe("unavailable")
    expect(value.items[6].unknown).toBe("not_checked")
    expect(value.items[2].update_available).toBe(true)
    // counted here, from the items: withdrawn with a newer revision counts
    expect(value.count).toBe(2)
  })

  it("never offers an update the answer does not name a newer revision for", () => {
    const value = normalizeHarnessUpdates(
      rawUpdates({
        count: 9,
        items: [
          // no latest
          {
            id: "x",
            revision: 1,
            state: "update_available",
            update_available: true,
          },
          // latest not newer
          {
            id: "y",
            revision: 3,
            state: "update_available",
            update_available: true,
            latest: { revision: 3, version: null },
          },
          // a duplicate, and entries that are not items
          { id: "x", revision: 1, state: "latest" },
          { revision: 1 },
          "item",
        ],
      })
    )
    expect(value.items.map((item) => item.update_available)).toEqual([
      false,
      false,
    ])
    expect(value.count).toBe(0)
  })

  it("reads a plugin's update: its target, agreement, Codeg's switch", () => {
    const plugin = (
      revision: number,
      target: number | null,
      suspended: boolean,
      state = "update_available"
    ) => ({
      id: `p-${revision}-${target}-${suspended}-${state}`,
      revision,
      state,
      update_available: true,
      latest: { revision: 5, version: "5.0.0" },
      ref: "obra/superpowers",
      plugin: {
        target:
          target === null
            ? null
            : { revision: target, version: `${target}.0.0` },
        needs_consent: suspended,
        suspended,
      },
    })
    const value = normalizeHarnessUpdates(
      rawUpdates({
        items: [
          // an update to the revision to install whole, not the newest
          plugin(1, 2, false),
          // switched off by Codeg, approved again: back on is the update
          plugin(2, 2, true),
          // the same revision while it runs is no update
          plugin(2, 2, false),
          // nothing to install whole
          plugin(1, null, true, "unapproved"),
          // no plugin part: not a plugin's
          { id: "s", revision: 1, state: "latest", plugin: "x" },
        ],
      })
    )
    expect(value.items.map((entry) => entry.update_available)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ])
    expect(value.items[0].plugin).toEqual({
      target: { revision: 2, version: "2.0.0" },
      needs_consent: false,
      suspended: false,
    })
    expect(value.items[1].plugin?.needs_consent).toBe(true)
    expect(value.items[3].state).toBe("unapproved")
    expect(value.items[3].plugin?.target).toBeNull()
    expect(value.items[4].plugin).toBeNull()
    expect(value.count).toBe(2)
  })

  it("reads the failure of the last check and the switch", () => {
    const failed = normalizeHarnessUpdates(
      rawUpdates({ error: { code: "rate_limited", seconds: 60 } })
    )
    expect(failed.error).toEqual({
      code: "rate_limited",
      seconds: 60,
      status: null,
    })
    const off = normalizeHarnessUpdates({
      enabled: false,
      items: [],
      count: 0,
    })
    expect(off.enabled).toBe(false)
    expect(updatesById(off).size).toBe(0)
    expect(() => normalizeHarnessUpdates({ count: 1 })).toThrow(
      HarnessClientError
    )
    expect(() => normalizeHarnessUpdates("nope")).toThrow(HarnessClientError)
  })

  it("reads the event's count and ids, nothing else", () => {
    expect(
      normalizeUpdatesChanged({ count: 2, item_ids: ["a", 3, "b"], extra: 1 })
    ).toEqual({ count: 2, item_ids: ["a", "b"] })
    expect(normalizeUpdatesChanged(null)).toEqual({ count: 0, item_ids: [] })
  })
})

describe("the commands", () => {
  it("names each command and its argument as the backend reads them", async () => {
    mocks.call.mockResolvedValue(rawUpdates())
    await harnessUpdates()
    await harnessCheckUpdates()
    await harnessCheckUpdates(true)
    expect(mocks.call.mock.calls).toEqual([
      ["harness_updates"],
      ["harness_check_updates", { explicit: false }],
      ["harness_check_updates", { explicit: true }],
    ])
  })

  it("listens on the event", async () => {
    const stop = vi.fn()
    mocks.subscribe.mockResolvedValue(stop)
    const handler = vi.fn()
    expect(await onHarnessUpdatesChanged(handler)).toBe(stop)
    expect(mocks.subscribe.mock.calls[0][0]).toBe(HARNESS_UPDATES_CHANGED_EVENT)
    mocks.subscribe.mock.calls[0][1]({ count: 1, item_ids: ["a"] })
    expect(handler).toHaveBeenCalledWith({ count: 1, item_ids: ["a"] })
  })
})

describe("what the sections make of it", () => {
  const item = (over: Partial<HarnessUpdateItem>): HarnessUpdateItem => ({
    id: "a",
    revision: 1,
    state: "update_available",
    update_available: true,
    latest: { revision: 3, version: "3.0.0" },
    ref: "acme/a",
    unknown: null,
    plugin: null,
    ...over,
  })

  it("maps each state to its mark, and unknown to none", () => {
    expect(remoteStateOf(item({ state: "latest" }))).toBe("latest")
    expect(remoteStateOf(item({}))).toBe("updateAvailable")
    expect(remoteStateOf(item({ state: "yanked" }))).toBe("yanked")
    expect(remoteStateOf(item({ state: "disabled_by_author" }))).toBe(
      "disabledByAuthor"
    )
    expect(remoteStateOf(item({ state: "removed_by_harness" }))).toBe(
      "removedByHarness"
    )
    expect(remoteStateOf(item({ state: "gone" }))).toBe("gone")
    expect(remoteStateOf(item({ state: "unapproved" }))).toBe("unapproved")
    expect(remoteStateOf(item({ state: "unknown" }))).toBeNull()
    expect(remoteStateOf(undefined)).toBeNull()
  })

  it("says only what still holds of a revision the answer is not about", () => {
    // about the installed revision
    expect(remoteFor(item({}), 1)).toMatchObject({
      remote: "updateAvailable",
      updateAvailable: true,
      ref: "acme/a",
    })
    expect(remoteFor(item({ state: "yanked" }), 1)).toMatchObject({
      remote: "yanked",
      updateAvailable: true,
    })
    // the listing already shows the update to the latest: nothing stale
    expect(remoteFor(item({}), 3)).toMatchObject({
      remote: null,
      updateAvailable: false,
    })
    // updated to one between: still an update
    expect(remoteFor(item({}), 2)).toMatchObject({
      remote: "updateAvailable",
      updateAvailable: true,
    })
    // an item gone or stopped is so whichever revision the listing has
    expect(
      remoteFor(item({ state: "gone", update_available: false }), 5)
    ).toMatchObject({ remote: "gone", updateAvailable: false })
    expect(
      remoteFor(
        item({ state: "disabled_by_author", update_available: false }),
        5
      )
    ).toMatchObject({ remote: "disabledByAuthor", updateAvailable: false })
    // a revision's own state is not
    expect(remoteFor(item({ state: "yanked" }), 3)).toMatchObject({
      remote: null,
    })
    // a plugin: its target, and its own revision once Codeg switched it off
    const target = (revision: number, suspended: boolean) => ({
      target: { revision, version: null },
      needs_consent: suspended,
      suspended,
    })
    expect(remoteFor(item({ plugin: target(2, false) }), 2)).toMatchObject({
      updateAvailable: false,
    })
    expect(remoteFor(item({ plugin: target(2, false) }), 1)).toMatchObject({
      remote: "updateAvailable",
      updateAvailable: true,
    })
    expect(
      remoteFor(item({ revision: 2, plugin: target(2, true) }), 2)
    ).toMatchObject({ remote: "updateAvailable", updateAvailable: true })
    expect(
      remoteFor(item({ state: "unapproved", plugin: target(3, true) }), 1)
    ).toMatchObject({ remote: "unapproved", updateAvailable: true })
    expect(remoteFor(null, 1)).toEqual({
      remote: null,
      updateAvailable: false,
      latest: null,
      ref: null,
    })
  })

  it("asks for a check when the last answer is over an hour old", () => {
    const value = normalizeHarnessUpdates(rawUpdates())
    const at = Date.parse("2026-11-17T09:00:00.000Z")
    expect(checkIsStale(value, at + CHECK_FRESH_MS - 1)).toBe(false)
    expect(checkIsStale(value, at + CHECK_FRESH_MS)).toBe(true)
    expect(checkIsStale({ ...value, checked_at: null }, at)).toBe(true)
    expect(
      checkIsStale({ ...value, enabled: false, checked_at: null }, at)
    ).toBe(false)
  })
})

describe("the slot", () => {
  it("lands answers in the order they were asked for", async () => {
    const slots = createHarnessSlotStore()
    const check = deferred<unknown>()
    const read = deferred<unknown>()
    mocks.call.mockImplementation((command: string) =>
      command === "harness_check_updates" ? check.promise : read.promise
    )
    const checking = checkHarnessUpdates(slots, true)
    expect(slots.get(HARNESS_UPDATES).checking).toBe(true)
    // asked for while the check runs: read after it lands, never before
    const reading = reloadHarnessUpdates(slots)
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
    await new Promise((done) => setTimeout(done, 0))
    expect(mocks.call).toHaveBeenCalledTimes(1)

    check.resolve(rawUpdates({ checked_at: "2026-11-17T10:00:00.000Z" }))
    await checking
    expect(slots.get(HARNESS_UPDATES).value?.checked_at).toBe(
      "2026-11-17T10:00:00.000Z"
    )
    expect(slots.get(HARNESS_UPDATES).checking).toBe(false)
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    read.resolve(
      rawUpdates({ checked_at: "2026-11-17T10:00:00.000Z", items: [] })
    )
    await reading
    expect(slots.get(HARNESS_UPDATES).value?.items).toEqual([])
    expect(mocks.call.mock.calls.map((args) => args[0])).toEqual([
      "harness_check_updates",
      "harness_updates",
    ])
  })

  it("reads once for a burst of reasons to read", async () => {
    const slots = createHarnessSlotStore()
    const first = deferred<unknown>()
    mocks.call.mockReturnValueOnce(first.promise)
    mocks.call.mockResolvedValue(rawUpdates())
    const one = reloadHarnessUpdates(slots)
    await Promise.resolve()
    const two = reloadHarnessUpdates(slots)
    const three = reloadHarnessUpdates(slots)
    expect(two).toBe(three)
    first.resolve(rawUpdates())
    await Promise.all([one, two, three])
    expect(mocks.call).toHaveBeenCalledTimes(2)
  })

  it("follows a check the host is running until it ends, changed or not", async () => {
    vi.useFakeTimers()
    try {
      const slots = createHarnessSlotStore()
      mocks.call.mockResolvedValueOnce(rawUpdates({ checking: true }))
      mocks.call.mockResolvedValueOnce(rawUpdates({ checking: true }))
      mocks.call.mockResolvedValue(rawUpdates())
      await reloadHarnessUpdates(slots)
      expect(slots.get(HARNESS_UPDATES).value?.checking).toBe(true)
      await vi.advanceTimersByTimeAsync(CHECKING_REREAD_MS)
      expect(mocks.call).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(CHECKING_REREAD_MS)
      expect(mocks.call).toHaveBeenCalledTimes(3)
      expect(slots.get(HARNESS_UPDATES).value?.checking).toBe(false)
      // done: nothing more is read
      await vi.advanceTimersByTimeAsync(CHECKING_REREAD_MS * 5)
      expect(mocks.call).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps the last answer when a read fails", async () => {
    const slots = createHarnessSlotStore()
    mocks.call.mockResolvedValueOnce(rawUpdates())
    await reloadHarnessUpdates(slots)
    mocks.call.mockRejectedValueOnce(new Error("gone"))
    await reloadHarnessUpdates(slots)
    const state = slots.get(HARNESS_UPDATES)
    expect(state.phase).toBe("error")
    expect(state.value?.count).toBe(1)
    // a failed explicit check still lets go of "checking"
    mocks.call.mockRejectedValueOnce(new Error("gone"))
    await checkHarnessUpdates(slots, true)
    expect(slots.get(HARNESS_UPDATES).checking).toBe(false)
  })
})
