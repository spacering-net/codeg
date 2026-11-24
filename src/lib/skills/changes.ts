/**
 * One subscription to `skills://changed` per window, shared by everything
 * that has to follow it: the chat's skill caches (`useAgentSkills`,
 * `useEnabledSkillIds`) and the Harness page's Skills and Skill-packs
 * sections.
 *
 * Opened when the first listener comes and closed when the last one goes, so
 * a window with nothing to keep fresh holds no subscription. A listener is
 * also told — with `null` — when the event stream reconnects: events sent
 * while it was down are lost, so anything may have changed.
 */
import { getTransport, type UnsubscribeFn } from "@/lib/transport"
import { onSkillsChanged } from "./api"
import type { SkillsChanged } from "./types"

/** `null`: the stream reconnected, and anything may have changed. */
export type SkillsChangeListener = (change: SkillsChanged | null) => void

const listeners = new Set<SkillsChangeListener>()
let close: (() => void) | null = null

function tell(change: SkillsChanged | null) {
  // A copy: a listener may stop listening (or another start) while it runs.
  for (const listener of [...listeners]) listener(change)
}

function open(): () => void {
  let closed = false
  let stopEvents: UnsubscribeFn | null = null
  let stopReconnect: UnsubscribeFn | undefined
  try {
    onSkillsChanged((change) => tell(change))
      .then((stop) => {
        if (closed) stop()
        else stopEvents = stop
      })
      .catch(() => {
        // No event stream: the caches still refresh on window focus, and the
        // page reads again on every visit and on Refresh.
      })
    stopReconnect = getTransport().onReconnect?.(() => tell(null))
  } catch {
    // A transport that cannot subscribe at all: as above.
  }
  return () => {
    closed = true
    stopEvents?.()
    stopReconnect?.()
  }
}

/** Follow `skills://changed` until the returned function is called. */
export function listenSkillsChanged(
  listener: SkillsChangeListener
): () => void {
  listeners.add(listener)
  if (!close) close = open()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && close) {
      close()
      close = null
    }
  }
}
