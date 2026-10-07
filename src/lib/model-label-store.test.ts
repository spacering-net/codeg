import { beforeEach, describe, expect, it, vi } from "vitest"

import type {
  SessionConfigOptionInfo,
  SessionConfigSelectOptionInfo,
} from "@/lib/types"

const STORAGE_KEY = "codeg:model-labels"

// The store hydrates from localStorage once and caches at module scope, so a
// test that seeds storage has to get a module that has not read it yet.
beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
})

function asRecord(labels: ReadonlyMap<string, string>) {
  return Object.fromEntries(labels)
}

async function load() {
  return import("./model-label-store")
}

function opt(value: string, name: string): SessionConfigSelectOptionInfo {
  return { value, name }
}

function select(
  options: SessionConfigSelectOptionInfo[],
  overrides: Partial<SessionConfigOptionInfo> = {}
): SessionConfigOptionInfo {
  return {
    id: "model",
    name: "Model",
    kind: {
      type: "select",
      current_value: options[0]?.value ?? "",
      options,
      groups: [],
    },
    ...overrides,
  }
}

const QODER_MODELS = select([
  opt("qfmodel", "Qwen3.8-Flash"),
  opt("qmodel_38max", "Qwen3.8-Max"),
])

describe("rememberModelLabels", () => {
  it("records the agent's own name for an opaque model id", async () => {
    const store = await load()
    store.rememberModelLabels("qoder", [QODER_MODELS])
    expect(asRecord(store.getModelLabels("qoder"))).toEqual({
      qfmodel: "Qwen3.8-Flash",
      qmodel_38max: "Qwen3.8-Max",
    })
  })

  it("merges rather than replaces, so a shrinking catalog keeps old labels", async () => {
    const store = await load()
    store.rememberModelLabels("qoder", [QODER_MODELS])
    // The catalog turns over: one model is gone, another is new. The write has
    // to carry the departed model's label forward, or the sessions that used it
    // lose their name. (The new model matters: a payload that teaches nothing
    // short-circuits before the merge and would not exercise it.)
    store.rememberModelLabels("qoder", [select([opt("qx", "Qwen X")])])
    expect(asRecord(store.getModelLabels("qoder"))).toEqual({
      qfmodel: "Qwen3.8-Flash",
      qmodel_38max: "Qwen3.8-Max",
      qx: "Qwen X",
    })
  })

  it("relabels a model the agent renamed", async () => {
    const store = await load()
    store.rememberModelLabels("qoder", [select([opt("qfmodel", "Qwen3.8")])])
    store.rememberModelLabels("qoder", [
      select([opt("qfmodel", "Qwen3.8-Flash")]),
    ])
    expect(store.getModelLabels("qoder").get("qfmodel")).toBe("Qwen3.8-Flash")
  })

  it("keeps agents apart so one cannot relabel another's model", async () => {
    const store = await load()
    store.rememberModelLabels("qoder", [select([opt("auto", "Auto")])])
    store.rememberModelLabels("grok", [select([opt("auto", "Automatic")])])
    expect(store.getModelLabels("qoder").get("auto")).toBe("Auto")
    expect(store.getModelLabels("grok").get("auto")).toBe("Automatic")
  })

  it("stores nothing when the label IS the id", async () => {
    const store = await load()
    store.rememberModelLabels("claude", [
      select([opt("claude-opus-5", "claude-opus-5")]),
    ])
    expect(asRecord(store.getModelLabels("claude"))).toEqual({})
  })

  it("ignores a reasoning-effort selector riding the model category", async () => {
    // qoder publishes `reasoning_effort` with `category: "model"`, which the
    // composer's `isModelConfigOption` matches — its values are not model ids.
    const store = await load()
    store.rememberModelLabels("qoder", [
      select([opt("low", "Low"), opt("high", "High")], {
        id: "reasoning_effort",
        category: "model",
      }),
      QODER_MODELS,
    ])
    expect(asRecord(store.getModelLabels("qoder"))).toEqual({
      qfmodel: "Qwen3.8-Flash",
      qmodel_38max: "Qwen3.8-Max",
    })
  })

  it("falls back to the category when no option is named `model`", async () => {
    const store = await load()
    store.rememberModelLabels("acme", [
      select([opt("x1", "Acme One")], {
        id: "primary-model",
        category: "model",
      }),
    ])
    expect(store.getModelLabels("acme").get("x1")).toBe("Acme One")
  })

  it("notifies subscribers only when something was learned", async () => {
    const store = await load()
    const listener = vi.fn()
    store.subscribeModelLabels(listener)
    store.rememberModelLabels("qoder", [QODER_MODELS])
    expect(listener).toHaveBeenCalledTimes(1)
    // Same payload again: nothing new, so no write and no re-render.
    store.rememberModelLabels("qoder", [QODER_MODELS])
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("leaves other agents' snapshots referentially stable", async () => {
    const store = await load()
    store.rememberModelLabels("qoder", [QODER_MODELS])
    const before = store.getModelLabels("grok")
    store.rememberModelLabels("qoder", [select([opt("qx", "Qwen X")])])
    // A write for qoder must not invalidate grok's snapshot — an unstable
    // reference here re-renders every surface reading it.
    expect(store.getModelLabels("grok")).toBe(before)
  })
})

describe("persistence", () => {
  it("survives a reload", async () => {
    const first = await load()
    first.rememberModelLabels("qoder", [QODER_MODELS])
    vi.resetModules()
    const second = await import("./model-label-store")
    expect(second.getModelLabels("qoder").get("qfmodel")).toBe("Qwen3.8-Flash")
  })

  it.each([
    ["not JSON at all", "{{{"],
    ["a JSON scalar", "42"],
    ["an array", '["qoder"]'],
    ["buckets that are not records", '{"qoder":["qfmodel"]}'],
    ["labels that are not strings", '{"qoder":{"qfmodel":{"name":"x"}}}'],
    ["a blank label", '{"qoder":{"qfmodel":"   "}}'],
  ])("tolerates stored %s", async (_label, raw) => {
    localStorage.setItem(STORAGE_KEY, raw)
    const store = await load()
    expect(asRecord(store.getModelLabels("qoder"))).toEqual({})
    // Still usable afterwards: a corrupt read must not wedge the store.
    store.rememberModelLabels("qoder", [QODER_MODELS])
    expect(store.getModelLabels("qoder").get("qfmodel")).toBe("Qwen3.8-Flash")
  })

  it("round-trips an agent and a model literally named `__proto__`", async () => {
    const first = await load()
    first.rememberModelLabels("__proto__", [
      select([opt("__proto__", "Weird One")]),
    ])
    vi.resetModules()
    const second = await import("./model-label-store")
    // Data, not a re-parented map: the reload must not let this entry answer
    // lookups for a different agent.
    expect(second.getModelLabels("__proto__").get("__proto__")).toBe(
      "Weird One"
    )
    expect(second.getModelLabels("qoder").size).toBe(0)
  })

  it("does not let a crafted `__proto__` bucket answer for another agent", async () => {
    localStorage.setItem(STORAGE_KEY, '{"__proto__":{"qoder":"pwned"}}')
    const store = await load()
    const qoder = store.getModelLabels("qoder")
    expect(qoder).toBeInstanceOf(Map)
    expect(qoder.size).toBe(0)
  })
})

describe("getModelLabels", () => {
  it("returns a stable empty map for an agent nothing has named", async () => {
    const store = await load()
    expect(store.getModelLabels("qoder")).toBe(store.getModelLabels("grok"))
  })

  it("misses `__proto__` instead of answering with the prototype", async () => {
    // A plain object would hand back `Object.prototype` here, which defeats the
    // caller's `?? rawId` fallback and puts an object into a React text slot.
    const store = await load()
    expect(store.getModelLabels("qoder").get("__proto__")).toBeUndefined()
    store.rememberModelLabels("qoder", [QODER_MODELS])
    expect(store.getModelLabels("qoder").get("__proto__")).toBeUndefined()
    expect(store.getModelLabels("qoder").get("constructor")).toBeUndefined()
  })
})
