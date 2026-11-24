"use client"

import { useCallback, useSyncExternalStore } from "react"

/**
 * Open/closed state of every expandable activity row, kept OUTSIDE the
 * component tree.
 *
 * The thread is virtualized and a live reply is rebuilt twice on its way into
 * history (the stream settling into a promoted turn, then the authoritative
 * reload), so state held in a row component is lost whenever the row unmounts
 * — scrolling away from a command you opened and back would close it again.
 * Keyed by the step's key (a tool call id where there is one), the choice
 * survives all of that.
 *
 * Bounded: the oldest choices are dropped past `MAX_ENTRIES`, which is far
 * more rows than anyone opens by hand in a session.
 */
const MAX_ENTRIES = 1024

const choices = new Map<string, boolean>()
/** Rows that once demanded attention (a failure, a pending approval). They
 *  stay open by default even after the state that opened them is gone. */
const latched = new Set<string>()
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function remember(key: string, open: boolean) {
  choices.delete(key)
  choices.set(key, open)
  if (choices.size > MAX_ENTRIES) {
    const oldest = choices.keys().next().value
    if (oldest !== undefined) choices.delete(oldest)
  }
}

function latch(key: string) {
  if (latched.has(key)) return
  latched.add(key)
  if (latched.size > MAX_ENTRIES) {
    const oldest = latched.values().next().value
    if (oldest !== undefined) latched.delete(oldest)
  }
}

/**
 * `expanded = userChoice ?? (latched || defaultOpen)`: what the reader chose
 * wins; otherwise a row that ever had to be seen stays open; otherwise the
 * row's kind and state decide. The latch is one-way, so a row never closes
 * itself under the reader when its state moves on.
 */
export function useDisclosure(
  key: string,
  opts: { defaultOpen: boolean; force?: boolean }
): [boolean, (open: boolean) => void] {
  const choice = useSyncExternalStore(
    subscribe,
    () => choices.get(key),
    () => undefined
  )
  if (opts.force) latch(key)
  const open = choice ?? (latched.has(key) || opts.defaultOpen)
  const setOpen = useCallback(
    (next: boolean) => {
      remember(key, next)
      emit()
    },
    [key]
  )
  return [open, setOpen]
}

/** Open rows from outside them (the header's "show the failure"). */
export function openDisclosures(keys: readonly string[]): void {
  for (const key of keys) remember(key, true)
  emit()
}

/** Forget every remembered choice. For tests. */
export function resetDisclosureStore(): void {
  choices.clear()
  latched.clear()
  emit()
}
