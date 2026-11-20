import type { MemoryCounters, MemoryMetric } from "./frontend-memory"

function increment(
  counters: MemoryCounters,
  key: MemoryMetric,
  amount = 1
): void {
  counters[key] = Math.min(
    Number.MAX_SAFE_INTEGER,
    (counters[key] ?? 0) + amount
  )
}

/** Fixed numeric buckets, never a command-keyed map or an argument/response log. */
export function createTauriCallMemoryCounters() {
  const counters: MemoryCounters = {
    shellCallsStarted: 0,
    shellCallsPending: 0,
    shellCallsResolved: 0,
    shellCallsRejected: 0,
    shellCallsDiagnostics: 0,
    shellCallsGitHead: 0,
    shellCallsConnectionTouch: 0,
    shellCallsMcpStatus: 0,
    shellCallsOther: 0,
  }
  return {
    read: (): MemoryCounters => ({ ...counters }),
    begin(command: string): (rejected: boolean) => void {
      increment(counters, "shellCallsStarted")
      increment(counters, "shellCallsPending")
      const bucket =
        command === "report_frontend_memory"
          ? "shellCallsDiagnostics"
          : command === "get_git_head"
            ? "shellCallsGitHead"
            : command === "acp_touch_connection"
              ? "shellCallsConnectionTouch"
              : command === "get_codeg_mcp_service_status"
                ? "shellCallsMcpStatus"
                : "shellCallsOther"
      increment(counters, bucket)
      let finished = false
      return (rejected) => {
        if (finished) return
        finished = true
        counters.shellCallsPending = Math.max(
          0,
          (counters.shellCallsPending ?? 0) - 1
        )
        increment(
          counters,
          rejected ? "shellCallsRejected" : "shellCallsResolved"
        )
      }
    },
  }
}

let shellCalls: ReturnType<typeof createTauriCallMemoryCounters> | undefined

function tauriCallCounters() {
  return (shellCalls ??= createTauriCallMemoryCounters())
}

// Called only from the opt-in TauriTransport.call branch. It does not cover
// direct SDK invoke(), plugin listeners, response bytes, or total IPC volume.
export function beginTauriMemoryCall(command: string) {
  return tauriCallCounters().begin(command)
}

export function readTauriMemoryCalls(): MemoryCounters {
  return tauriCallCounters().read()
}

/**
 * Records counts only within each delivery microtask. No node, MutationRecord,
 * attribute name/value, text, or oldValue is retained in the numeric state.
 */
export function createDomMutationMemoryCounters() {
  const counters: MemoryCounters = {}
  let observer: MutationObserver | undefined
  let disposed = false
  try {
    if (
      typeof MutationObserver === "function" &&
      typeof document !== "undefined"
    ) {
      observer = new MutationObserver((records) => {
        if (disposed) return
        for (const record of records) {
          if (record.type === "childList") {
            increment(counters, "domMutationChildList")
            increment(
              counters,
              "domMutationNodesAdded",
              record.addedNodes.length
            )
            increment(
              counters,
              "domMutationNodesRemoved",
              record.removedNodes.length
            )
          } else if (record.type === "attributes") {
            increment(counters, "domMutationAttributes")
          } else if (record.type === "characterData") {
            increment(counters, "domMutationCharacterData")
          }
        }
      })
      observer.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
        attributeOldValue: false,
        characterDataOldValue: false,
      })
      Object.assign(counters, {
        domMutationChildList: 0,
        domMutationNodesAdded: 0,
        domMutationNodesRemoved: 0,
        domMutationAttributes: 0,
        domMutationCharacterData: 0,
      })
    }
  } catch {
    observer?.disconnect()
    observer = undefined
  }
  return {
    read: (): MemoryCounters => ({ ...counters }),
    dispose: () => {
      if (disposed) return
      disposed = true
      observer?.disconnect()
      observer = undefined
    },
  }
}
