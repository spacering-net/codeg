import { describe, expect, it, vi } from "vitest"

import { createHarnessSlotStore, defineHarnessSlot } from "./harness-slots"

describe("Harness slot store", () => {
  it("holds a slot's initial value until it is written", () => {
    const query = defineHarnessSlot<string>("discover", () => "")
    const store = createHarnessSlotStore()

    expect(store.get(query)).toBe("")
    store.set(query, "pdf")
    expect(store.get(query)).toBe("pdf")
  })

  it("builds the initial value once, so a snapshot keeps its identity", () => {
    // `useSyncExternalStore` compares snapshots by identity: a slot whose
    // initial value is a fresh object on every read would re-render forever.
    const initial = vi.fn(() => ({ ids: [] as string[] }))
    const selection = defineHarnessSlot("mcp", initial)
    const store = createHarnessSlotStore()

    const first = store.get(selection)
    expect(store.get(selection)).toBe(first)
    expect(initial).toHaveBeenCalledTimes(1)
  })

  it("gives each store its own initial value", () => {
    // Two windows' worth of state must not share one mutable object.
    const log = defineHarnessSlot<string[]>("packs", () => [])
    const a = createHarnessSlotStore()
    const b = createHarnessSlotStore()

    a.get(log).push("installing…")
    expect(b.get(log)).toEqual([])
  })

  it("takes an updater, as useState does", () => {
    const count = defineHarnessSlot<number>("skills", () => 1)
    const store = createHarnessSlotStore()

    store.set(count, (prev) => prev + 1)
    store.set(count, (prev) => prev * 10)
    expect(store.get(count)).toBe(20)
  })

  it("tells only the written slot's listeners", () => {
    const query = defineHarnessSlot<string>("discover", () => "")
    const sort = defineHarnessSlot<string>("discover", () => "popular")
    const store = createHarnessSlotStore()
    const onQuery = vi.fn()
    const onSort = vi.fn()
    store.subscribe(query, onQuery)
    store.subscribe(sort, onSort)

    store.set(query, "pdf")

    // Typing in a search box must not re-render what reads the sort order —
    // let alone anything outside the section.
    expect(onQuery).toHaveBeenCalledTimes(1)
    expect(onSort).not.toHaveBeenCalled()
  })

  it("does not notify for a write that changes nothing", () => {
    const query = defineHarnessSlot<string>("discover", () => "pdf")
    const store = createHarnessSlotStore()
    const onQuery = vi.fn()
    store.subscribe(query, onQuery)

    store.set(query, "pdf")
    store.set(query, (prev) => prev)

    expect(onQuery).not.toHaveBeenCalled()
  })

  it("stops telling a listener that unsubscribed", () => {
    const query = defineHarnessSlot<string>("discover", () => "")
    const store = createHarnessSlotStore()
    const onQuery = vi.fn()
    const unsubscribe = store.subscribe(query, onQuery)

    unsubscribe()
    store.set(query, "pdf")

    expect(onQuery).not.toHaveBeenCalled()
    // …and the write still landed: the store is not there for its listeners.
    expect(store.get(query)).toBe("pdf")
  })

  it("keeps two slots apart even when they look the same", () => {
    // The descriptor is the key. Two declarations with the same section and
    // the same initial value are still two slots — nothing but the declaring
    // module can reach a slot's value.
    const a = defineHarnessSlot<string>("mcp", () => "")
    const b = defineHarnessSlot<string>("mcp", () => "")
    const store = createHarnessSlotStore()

    store.set(a, "left")
    expect(store.get(b)).toBe("")
  })

  it("resets one section and leaves the others", () => {
    const query = defineHarnessSlot<string>("discover", () => "")
    const tab = defineHarnessSlot<string>("packs", () => "experts")
    const store = createHarnessSlotStore()
    const onQuery = vi.fn()
    const onTab = vi.fn()
    store.set(query, "pdf")
    store.set(tab, "office")
    store.subscribe(query, onQuery)
    store.subscribe(tab, onTab)

    store.reset("discover")

    expect(store.get(query)).toBe("")
    expect(store.get(tab)).toBe("office")
    // A mounted reader has to hear about it, or it would keep showing the
    // value that is gone.
    expect(onQuery).toHaveBeenCalledTimes(1)
    expect(onTab).not.toHaveBeenCalled()
  })

  it("resets everything with no section named", () => {
    const query = defineHarnessSlot<string>("discover", () => "")
    const tab = defineHarnessSlot<string>("packs", () => "experts")
    const store = createHarnessSlotStore()
    store.set(query, "pdf")
    store.set(tab, "office")

    store.reset()

    expect(store.get(query)).toBe("")
    expect(store.get(tab)).toBe("experts")
  })

  it("lets a listener unsubscribe while it is being told", () => {
    const query = defineHarnessSlot<string>("discover", () => "")
    const store = createHarnessSlotStore()
    const second = vi.fn()
    const unsubscribeFirst = store.subscribe(query, () => unsubscribeFirst())
    store.subscribe(query, second)

    store.set(query, "pdf")

    expect(second).toHaveBeenCalledTimes(1)
  })
})
