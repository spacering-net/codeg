import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  rememberAgentModes,
  getCachedAgentModes,
  clearAgentModesCache,
} from "./agent-modes-cache"

const modes = (ids: string[], current = ids[0]) => ({
  current_mode_id: current,
  available_modes: ids.map((id) => ({ id, name: id, description: null })),
})

beforeEach(() => {
  window.localStorage.clear()
  clearAgentModesCache()
})

afterEach(() => {
  window.localStorage.clear()
})

describe("agent-modes-cache", () => {
  it("remembers the advertised mode ids per agent", () => {
    rememberAgentModes("zcode", modes(["build", "plan", "yolo"]))
    expect(getCachedAgentModes("zcode")).toEqual(["build", "plan", "yolo"])
  })

  it("replaces the list wholesale when the agent re-advertises", () => {
    rememberAgentModes("zcode", modes(["build", "plan", "yolo"]))
    rememberAgentModes("zcode", modes(["build", "plan"]))
    expect(getCachedAgentModes("zcode")).toEqual(["build", "plan"])
  })

  it("keeps agents separate", () => {
    rememberAgentModes("zcode", modes(["yolo"]))
    rememberAgentModes("codex", modes(["danger-full-access"]))
    expect(getCachedAgentModes("zcode")).toEqual(["yolo"])
    expect(getCachedAgentModes("codex")).toEqual(["danger-full-access"])
  })

  it("ignores an empty advertised list", () => {
    rememberAgentModes("zcode", modes([]))
    expect(getCachedAgentModes("zcode")).toEqual([])
  })

  it("survives a page reload via localStorage", async () => {
    rememberAgentModes("zcode", modes(["build", "yolo"]))
    window.localStorage.setItem(
      "codeg:agent-modes-cache",
      JSON.stringify({ zcode: ["build", "yolo"], __proto__: ["x"] })
    )
    // Simulate a fresh page: re-import the module from scratch.
    vi.resetModules()
    const fresh = await import("./agent-modes-cache")
    expect(fresh.getCachedAgentModes("zcode")).toEqual(["build", "yolo"])
    // Prototype-polluting keys degrade to "not cached".
    expect(fresh.getCachedAgentModes("__proto__")).toEqual([])
  })

  it("degrades corrupt storage to an empty cache", () => {
    window.localStorage.setItem("codeg:agent-modes-cache", "[not an object")
    clearAgentModesCache()
    expect(getCachedAgentModes("zcode")).toEqual([])
  })
})
