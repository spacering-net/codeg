import type { HarnessSectionId } from "@/lib/harness-sections"

/**
 * Per-section state that outlives the Harness page.
 *
 * A workbench route page is unmounted the moment the user goes back to a
 * conversation, and everything its components hold in `useState` goes with it.
 * What a section must still have on the way back — search text, filters, the
 * selected row, a scroll offset, an editor's unsaved content, the progress of
 * an install that is still running — lives in a slot instead, in a store the
 * always-mounted `HarnessViewProvider` owns.
 *
 * A slot is declared once, at module scope, next to the code that uses it:
 *
 *     const QUERY = defineHarnessSlot<string>("discover", () => "")
 *
 * and read with `useHarnessSlot(QUERY)` (a `useState` whose value survives the
 * page), or through the store itself where a render is not wanted — a scroll
 * offset saved on the way out, or a stream that keeps writing while the page
 * is gone.
 *
 * The descriptor IS the key: a value can only be reached through the typed
 * descriptor it was declared with, so two slots can never read each other's
 * state, however they are named. The section it names is what
 * {@link HarnessSlotStore.reset} goes by.
 */
export interface HarnessSlot<T> {
  readonly section: HarnessSectionId
  /** Builds the value a slot holds before anything is written to it. Called at
   *  most once per store, so it may return a fresh object or array. */
  readonly initial: () => T
}

export function defineHarnessSlot<T>(
  section: HarnessSectionId,
  initial: () => T
): HarnessSlot<T> {
  return { section, initial }
}

/** A next value, or a function of the current one — as with `useState`. So,
 *  as there, a slot cannot hold a function as its value. */
export type HarnessSlotUpdate<T> = T | ((prev: T) => T)

export interface HarnessSlotStore {
  /** The slot's current value. The same reference until it is written. */
  get<T>(slot: HarnessSlot<T>): T
  /** Write the slot. Writing the value it already holds notifies nobody. */
  set<T>(slot: HarnessSlot<T>, next: HarnessSlotUpdate<T>): void
  subscribe<T>(slot: HarnessSlot<T>, listener: () => void): () => void
  /** Put one section's slots — or, with no argument, every slot — back to
   *  their initial values. */
  reset(section?: HarnessSectionId): void
}

export function createHarnessSlotStore(): HarnessSlotStore {
  // Values are stored as `unknown` and typed on the way out by the descriptor
  // that keys them — the one place the cast is sound, since a descriptor only
  // ever stores what its own `initial` and `set` produced.
  const values = new Map<HarnessSlot<unknown>, unknown>()
  const listeners = new Map<HarnessSlot<unknown>, Set<() => void>>()

  const notify = (slot: HarnessSlot<unknown>) => {
    const slotListeners = listeners.get(slot)
    if (!slotListeners) return
    // A copy: a listener may unsubscribe (or subscribe another) while it runs.
    for (const listener of [...slotListeners]) listener()
  }

  function get<T>(slot: HarnessSlot<T>): T {
    const key = slot as HarnessSlot<unknown>
    // Kept once built: `useSyncExternalStore` compares snapshots by identity,
    // and an `initial` that returns a new object on every read would have it
    // re-render forever.
    if (!values.has(key)) values.set(key, slot.initial())
    return values.get(key) as T
  }

  function set<T>(slot: HarnessSlot<T>, next: HarnessSlotUpdate<T>): void {
    const key = slot as HarnessSlot<unknown>
    const prev = get(slot)
    const value =
      typeof next === "function" ? (next as (prev: T) => T)(prev) : next
    if (Object.is(prev, value)) return
    values.set(key, value)
    notify(key)
  }

  function subscribe<T>(slot: HarnessSlot<T>, listener: () => void) {
    const key = slot as HarnessSlot<unknown>
    const existing = listeners.get(key)
    const slotListeners = existing ?? new Set<() => void>()
    if (!existing) listeners.set(key, slotListeners)
    slotListeners.add(listener)
    return () => {
      slotListeners.delete(listener)
      if (slotListeners.size === 0 && listeners.get(key) === slotListeners) {
        listeners.delete(key)
      }
    }
  }

  function reset(section?: HarnessSectionId): void {
    const dropped: HarnessSlot<unknown>[] = []
    for (const slot of values.keys()) {
      if (section === undefined || slot.section === section) dropped.push(slot)
    }
    // Forget them all before telling anyone, so a listener that reads a
    // sibling slot on the way sees it reset too.
    for (const slot of dropped) values.delete(slot)
    for (const slot of dropped) notify(slot)
  }

  return { get, set, subscribe, reset }
}
