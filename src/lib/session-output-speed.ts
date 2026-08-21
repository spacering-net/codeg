/**
 * Per-conversation generating-only output speed.
 *
 * Live tok/s is a one-turn EWMA. This store keeps the session average:
 * estimated output tokens / generating milliseconds, with tool waits (and
 * any other `pause`) excluded. The live turn writes its current generating
 * totals into a replaceable "live" slot so a 2 Hz sample does not
 * double-count; committing that slot at turn end (or unmount) folds it
 * into the session.
 *
 * In-memory only: a reload has no generating clock to recover from the
 * transcript, so we would rather show nothing than a wall-clock rate that
 * includes every tool wait.
 */

export interface SessionOutputSpeed {
  averageTps: number
  generatingMs: number
  outputTokens: number
}

const WARMUP_MS = 300

type Slot = {
  committedTokens: number
  committedMs: number
  liveTokens: number
  liveMs: number
}

const slots = new Map<number, Slot>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function slotOf(conversationId: number): Slot {
  let slot = slots.get(conversationId)
  if (!slot) {
    slot = {
      committedTokens: 0,
      committedMs: 0,
      liveTokens: 0,
      liveMs: 0,
    }
    slots.set(conversationId, slot)
  }
  return slot
}

function snapshotOf(slot: Slot): SessionOutputSpeed | null {
  const generatingMs = slot.committedMs + slot.liveMs
  const outputTokens = slot.committedTokens + slot.liveTokens
  if (generatingMs < WARMUP_MS) return null
  return {
    averageTps: outputTokens / (generatingMs / 1000),
    generatingMs,
    outputTokens,
  }
}

/** Replace the current turn's generating totals (not additive). */
export function setLiveSessionOutputSpeed(
  conversationId: number,
  generatingTokens: number,
  generatingMs: number
): void {
  const slot = slotOf(conversationId)
  if (slot.liveTokens === generatingTokens && slot.liveMs === generatingMs) {
    return
  }
  slot.liveTokens = generatingTokens
  slot.liveMs = generatingMs
  emit()
}

/** Fold the live turn into the session and clear the live slot. */
export function commitLiveSessionOutputSpeed(conversationId: number): void {
  const slot = slots.get(conversationId)
  if (!slot) return
  if (slot.liveTokens === 0 && slot.liveMs === 0) return
  slot.committedTokens += slot.liveTokens
  slot.committedMs += slot.liveMs
  slot.liveTokens = 0
  slot.liveMs = 0
  emit()
}

/** Follow a virtual runtime id that reconciled to a persisted conversation. */
export function migrateSessionOutputSpeed(
  fromConversationId: number,
  toConversationId: number
): void {
  if (fromConversationId === toConversationId) return
  const from = slots.get(fromConversationId)
  if (!from) return
  const to = slots.get(toConversationId)
  if (!to) {
    slots.set(toConversationId, from)
  } else {
    to.committedTokens += from.committedTokens + from.liveTokens
    to.committedMs += from.committedMs + from.liveMs
  }
  slots.delete(fromConversationId)
  emit()
}

export function getSessionOutputSpeed(
  conversationId: number | null | undefined
): SessionOutputSpeed | null {
  if (conversationId == null) return null
  const slot = slots.get(conversationId)
  return slot ? snapshotOf(slot) : null
}

export function subscribeSessionOutputSpeed(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test helper: drop every session so cases cannot leak into each other. */
export function resetSessionOutputSpeedForTests(): void {
  slots.clear()
  emit()
}
