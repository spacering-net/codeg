import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createDomMutationMemoryCounters,
  createTauriCallMemoryCounters,
} from "./frontend-memory-activity"

afterEach(() => vi.unstubAllGlobals())

describe("fixed numeric Tauri call activity", () => {
  it("tracks pending calls and outcomes in fixed buckets without command history", () => {
    const calls = createTauriCallMemoryCounters()
    const first = calls.begin("get_git_head")
    const second = calls.begin("report_frontend_memory")
    expect(calls.read()).toMatchObject({
      shellCallsStarted: 2,
      shellCallsPending: 2,
      shellCallsGitHead: 1,
      shellCallsDiagnostics: 1,
    })
    const snapshot = calls.read()
    first(false)
    first(true)
    second(true)
    for (let index = 0; index < 1000; index++) {
      calls.begin(`unlisted-private-${index}`)(false)
    }
    calls.begin("acp_touch_connection")(false)
    calls.begin("get_codeg_mcp_service_status")(false)
    expect(calls.read()).toEqual({
      shellCallsStarted: 1004,
      shellCallsPending: 0,
      shellCallsResolved: 1003,
      shellCallsRejected: 1,
      shellCallsGitHead: 1,
      shellCallsDiagnostics: 1,
      shellCallsConnectionTouch: 1,
      shellCallsMcpStatus: 1,
      shellCallsOther: 1000,
    })
    expect(snapshot.shellCallsPending).toBe(2)
    expect(Object.keys(calls.read())).toHaveLength(9)
    expect(JSON.stringify(calls.read())).not.toContain("private")
  })
})

describe("numeric DOM mutation activity", () => {
  it("counts actual mutations and stops observing after disposal", async () => {
    const element = document.createElement("div")
    const text = document.createTextNode("owned fixture")
    element.append(text)
    const activity = createDomMutationMemoryCounters()
    document.body.append(element)
    element.setAttribute("data-owned", "not collected")
    text.data = "still not collected"
    element.remove()
    await Promise.resolve()
    expect(activity.read()).toEqual({
      domMutationChildList: 2,
      domMutationNodesAdded: 1,
      domMutationNodesRemoved: 1,
      domMutationAttributes: 1,
      domMutationCharacterData: 1,
    })
    const snapshot = activity.read()
    activity.dispose()
    activity.dispose()
    document.body.append(element)
    element.setAttribute("data-owned", "after disposal")
    await Promise.resolve()
    expect(activity.read()).toEqual(snapshot)
    element.remove()
  })

  it("does not read target, text, attribute names, values or node contents", () => {
    let deliver: MutationCallback | undefined
    const disconnect = vi.fn()
    vi.stubGlobal(
      "MutationObserver",
      class {
        constructor(callback: MutationCallback) {
          deliver = callback
        }
        observe = vi.fn()
        disconnect = disconnect
      }
    )
    const privateRead = vi.fn(() => {
      throw new Error("Private mutation contents must not be read")
    })
    const records = ["childList", "attributes", "characterData"].map(
      (type) => ({
        type,
        addedNodes: {
          length: 3,
          get textContent() {
            return privateRead()
          },
        },
        removedNodes: { length: 2 },
        get target() {
          return privateRead()
        },
        get attributeName() {
          return privateRead()
        },
        get oldValue() {
          return privateRead()
        },
      })
    )
    const activity = createDomMutationMemoryCounters()
    deliver?.(records as unknown as MutationRecord[], {} as MutationObserver)
    expect(activity.read()).toEqual({
      domMutationChildList: 1,
      domMutationNodesAdded: 3,
      domMutationNodesRemoved: 2,
      domMutationAttributes: 1,
      domMutationCharacterData: 1,
    })
    expect(privateRead).not.toHaveBeenCalled()
    activity.dispose()
    activity.dispose()
    expect(disconnect).toHaveBeenCalledTimes(1)
    deliver?.(records as unknown as MutationRecord[], {} as MutationObserver)
    expect(activity.read().domMutationChildList).toBe(1)
  })

  it("omits unsupported or failed observation instead of claiming zero mutations", () => {
    vi.stubGlobal("MutationObserver", undefined)
    expect(createDomMutationMemoryCounters().read()).toEqual({})
    const disconnect = vi.fn()
    vi.stubGlobal(
      "MutationObserver",
      class {
        observe() {
          throw new Error("Unavailable document")
        }
        disconnect = disconnect
      }
    )
    const activity = createDomMutationMemoryCounters()
    expect(activity.read()).toEqual({})
    expect(disconnect).toHaveBeenCalledTimes(1)
    activity.dispose()
  })
})
