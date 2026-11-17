import type { Transport } from "./transport/types"

export const MEMORY_CONTROL_EVENT = "frontend-memory://control"

export interface FrontendMemoryControl {
  epoch: number
  reportingEnabled: boolean
  browserCountersEnabled: boolean
  sampleSequence: number
}

function parseControl(value: unknown): FrontendMemoryControl | undefined {
  if (!value || typeof value !== "object") return
  const control = value as FrontendMemoryControl
  if (
    !Number.isSafeInteger(control.epoch) ||
    control.epoch < 0 ||
    !Number.isSafeInteger(control.sampleSequence) ||
    control.sampleSequence < 0 ||
    control.sampleSequence > control.epoch ||
    typeof control.reportingEnabled !== "boolean" ||
    typeof control.browserCountersEnabled !== "boolean"
  )
    return
  // Copy only the numeric/boolean vocabulary. Never retain an event object.
  return {
    epoch: control.epoch,
    reportingEnabled: control.reportingEnabled,
    browserCountersEnabled: control.browserCountersEnabled,
    sampleSequence: control.sampleSequence,
  }
}

/** One latest desired mode, one worker, no queue of controls or samples. */
export function createFrontendMemoryController(options: {
  reporterId: string
  transport: Pick<Transport, "call" | "subscribe">
  flush: () => Promise<boolean>
  idle: () => Promise<unknown>
  setBrowserCountersEnabled: (enabled: boolean) => void
  active: () => boolean
  now?: () => number
}) {
  let disposed = false
  let desired: FrontendMemoryControl | undefined
  let acknowledgedEpoch = -1
  let completedSampleSequence = 0
  let sampledEpoch = 0
  let sampleStartedAtMs = 0
  let worker: Promise<void> | undefined
  let attemptedEpoch = -1
  let unsubscribe: (() => void) | undefined
  const now = options.now ?? Date.now

  async function applyLatest() {
    while (!disposed && desired && options.active()) {
      const target = desired
      attemptedEpoch = target.epoch
      // A prior report may already be inside real IPC. The mode acknowledgement
      // is sent only after it settles, never just when the setter returns.
      await options.idle()
      if (disposed || !options.active()) return
      if (target !== desired) continue
      if (target.sampleSequence > completedSampleSequence) {
        const startedAt = now()
        const sent = await options.flush()
        if (sent) {
          completedSampleSequence = target.sampleSequence
          sampledEpoch = target.epoch
          sampleStartedAtMs = startedAt
        }
        if (disposed || !options.active()) return
        if (target !== desired) continue
        if (!sent) return // No successful boundary sample, no completion claim.
      }
      const ack = {
        reporterId: options.reporterId,
        ...target,
        appliedAtMs: now(),
        sampledEpoch,
        sampleStartedAtMs,
      }
      if (!Number.isSafeInteger(ack.appliedAtMs) || ack.appliedAtMs < 0) return
      try {
        await options.transport.call("ack_frontend_memory_control", { ack })
      } catch {
        // A concurrent setter can reject an obsolete acknowledgement. Retry
        // only the newer desired mode, not the rejected event indefinitely.
        if (target !== desired) continue
        return
      }
      if (disposed || !options.active()) return
      if (target !== desired) continue
      acknowledgedEpoch = target.epoch
      return
    }
  }

  function startWorker() {
    if (!worker) {
      worker = applyLatest()
        .catch(() => {})
        .finally(() => {
          worker = undefined
          // An event can arrive after the async body returns but before this
          // finalizer. Process that newer epoch without spinning on failures.
          if (!disposed && desired && desired.epoch > attemptedEpoch)
            startWorker()
        })
    }
  }

  function accept(value: unknown) {
    if (disposed) return
    const next = parseControl(value)
    if (!next || (desired && next.epoch <= desired.epoch)) return
    desired = next
    options.setBrowserCountersEnabled(next.browserCountersEnabled)
    startWorker()
  }

  const ready = (async () => {
    try {
      const release = await options.transport.subscribe<unknown>(
        MEMORY_CONTROL_EVENT,
        accept
      )
      if (disposed) {
        release()
        return
      }
      unsubscribe = release
      // Subscribe first: an event racing this read wins through its epoch.
      const initial = await options.transport.call<unknown>(
        "get_frontend_memory_control"
      )
      accept(initial)
      await worker
    } catch {
      // Failed initialization leaves reporting inactive and cannot escape into
      // application bootstrap. Cleanup still releases any registered listener.
      unsubscribe?.()
      unsubscribe = undefined
      desired = undefined
    }
  })()

  return {
    ready,
    tick: () => {
      if (
        disposed ||
        worker ||
        !options.active() ||
        !desired?.reportingEnabled ||
        acknowledgedEpoch !== desired.epoch
      )
        return Promise.resolve(false)
      return options.flush()
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      desired = undefined
      unsubscribe?.()
      unsubscribe = undefined
    },
  }
}
