import { listActivePetSessions } from "@/lib/pet/api"
import type { PetSessionEntry, PetSessionsPayload } from "@/lib/pet/types"
import { getTransport } from "@/lib/transport"

const PET_SESSIONS_EVENT = "pet://sessions"

export type SessionEventKind = "finished" | "needsApproval" | "failed"

export interface SessionEvent {
  kind: SessionEventKind
  connectionId: string
  agentType: PetSessionEntry["agentType"]
  title: string
}

function relevant(
  sessions: PetSessionEntry[],
  ignoreConnectionId: string | null
): Map<string, PetSessionEntry> {
  const map = new Map<string, PetSessionEntry>()
  for (const entry of sessions) {
    if (entry.parent) continue
    if (entry.connectionId === ignoreConnectionId) continue
    map.set(entry.connectionId, entry)
  }
  return map
}

/**
 * Turns two consecutive `pet://sessions` payloads into announcement events.
 * Delegation children and the assistant's own connection are never reported.
 */
export function diffPetSessions(
  prev: PetSessionsPayload | null,
  next: PetSessionsPayload,
  ignoreConnectionId: string | null
): SessionEvent[] {
  const before = relevant(prev?.sessions ?? [], ignoreConnectionId)
  const after = relevant(next.sessions, ignoreConnectionId)
  const events: SessionEvent[] = []
  const event = (kind: SessionEventKind, entry: PetSessionEntry) =>
    events.push({
      kind,
      connectionId: entry.connectionId,
      agentType: entry.agentType,
      title: entry.title,
    })

  for (const [id, entry] of after) {
    const old = before.get(id)
    if (entry.pending && !old?.pending) event("needsApproval", entry)
    if (entry.status === "error" && old?.status !== "error") {
      event("failed", entry)
    }
  }
  for (const [id, old] of before) {
    if (after.has(id)) continue
    if (old.status === "prompting" && !old.pending) event("finished", old)
  }
  return events
}

/**
 * Watches every agent session in the workspace through the backend-owned
 * `pet://sessions` stream (seeded with a snapshot) and reports status changes.
 * Returns a stop function.
 */
export function watchWorkspaceSessions(
  onEvents: (events: SessionEvent[]) => void,
  getIgnoredConnectionId: () => string | null
): () => void {
  let stopped = false
  let last: PetSessionsPayload | null = null
  let liveSeen = false
  let unsubscribe: (() => void) | null = null

  const apply = (next: PetSessionsPayload) => {
    if (stopped) return
    const events = last
      ? diffPetSessions(last, next, getIgnoredConnectionId())
      : []
    last = next
    if (events.length > 0) onEvents(events)
  }

  void listActivePetSessions()
    .then((snapshot) => {
      if (!liveSeen) apply(snapshot)
    })
    .catch((error: unknown) => {
      console.warn("[VoiceMode] sessions snapshot failed:", error)
    })

  void getTransport()
    .subscribe<PetSessionsPayload>(PET_SESSIONS_EVENT, (payload) => {
      liveSeen = true
      apply(payload)
    })
    .then((unlisten) => {
      if (stopped) unlisten()
      else unsubscribe = unlisten
    })
    .catch((error: unknown) => {
      console.warn("[VoiceMode] sessions subscription failed:", error)
    })

  return () => {
    stopped = true
    unsubscribe?.()
    unsubscribe = null
  }
}
