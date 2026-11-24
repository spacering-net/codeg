import { describe, expect, it } from "vitest"

import { modelEffortRanges } from "@/lib/model-effort-range"
import type {
  ModelReasoningEffortsInfo,
  SessionConfigOptionInfo,
} from "@/lib/types"

function models(
  entries: [string, ModelReasoningEffortsInfo | null][]
): SessionConfigOptionInfo {
  return {
    id: "model",
    name: "Model",
    description: null,
    category: "model",
    kind: {
      type: "select",
      current_value: entries[0]![0],
      options: entries.map(([value, efforts]) => ({
        value,
        name: value,
        description: null,
        reasoning_efforts: efforts,
      })),
      groups: [],
    },
  }
}

function effort(levels: [string, string][]): SessionConfigOptionInfo {
  return {
    id: "reasoning_effort",
    name: "Reasoning effort",
    description: null,
    category: "thought_level",
    kind: {
      type: "select",
      current_value: levels[0]![0],
      options: levels.map(([value, name]) => ({
        value,
        name,
        description: null,
      })),
      groups: [],
    },
  }
}

const efforts = (...values: string[]): ModelReasoningEffortsInfo => ({
  values,
  recommended: values[0] ?? null,
})

describe("modelEffortRanges", () => {
  it("names each model's range when the models differ (codex-acp 2.10.0)", () => {
    // Live 2.10.0: GPT-5.5 is current, so the effort option lists its levels
    // only — `max` and `ultra` are named from their ids.
    const ranges = modelEffortRanges(
      models([
        [
          "gpt-6.2-sol",
          efforts("low", "medium", "high", "xhigh", "max", "ultra"),
        ],
        ["gpt-6-luna", efforts("low", "medium", "high", "xhigh", "max")],
        ["gpt-5.5", efforts("low", "medium", "high", "xhigh")],
      ]),
      effort([
        ["low", "Low"],
        ["medium", "Medium"],
        ["high", "High"],
        ["xhigh", "Xhigh"],
      ])
    )
    expect(ranges && Object.fromEntries(ranges)).toEqual({
      "gpt-6.2-sol": "Low–Ultra",
      "gpt-6-luna": "Low–Max",
      "gpt-5.5": "Low–Xhigh",
    })
  })

  it("takes a level's name from the effort option when it lists the level", () => {
    const ranges = modelEffortRanges(
      models([
        ["a", efforts("low", "high")],
        ["b", efforts("low", "medium")],
      ]),
      effort([
        ["low", "Gentle"],
        ["high", "Deep"],
      ])
    )
    expect(ranges?.get("a")).toBe("Gentle–Deep")
    expect(ranges?.get("b")).toBe("Gentle–Medium")
  })

  it("shows nothing when every model would show the same range (claude-agent-acp 0.110.0)", () => {
    const all = efforts("low", "medium", "high", "xhigh", "max")
    expect(
      modelEffortRanges(
        models([
          ["opus", all],
          ["sonnet", all],
          // A resumed older model without xhigh still reads Low–Max.
          ["claude-sonnet-4-6", efforts("low", "medium", "high", "max")],
        ]),
        null
      )
    ).toBeNull()
  })

  it("shows nothing when no model names its efforts", () => {
    expect(
      modelEffortRanges(
        models([
          ["a", null],
          ["b", { values: [], recommended: null }],
        ]),
        null
      )
    ).toBeNull()
  })

  it("leaves a model that names nothing without a range, and marks the rest", () => {
    const ranges = modelEffortRanges(
      models([
        ["cataloged", efforts("low", "high")],
        ["gateway/custom", null],
      ]),
      null
    )
    expect(ranges && Object.fromEntries(ranges)).toEqual({
      cataloged: "Low–High",
    })
  })

  it("names a single level once", () => {
    const ranges = modelEffortRanges(
      models([
        ["one", efforts("high")],
        ["two", efforts("low", "high")],
      ]),
      null
    )
    expect(ranges?.get("one")).toBe("High")
  })

  it("reads nothing from a boolean option", () => {
    expect(
      modelEffortRanges(
        {
          id: "model",
          name: "Model",
          description: null,
          category: "model",
          kind: { type: "boolean", current_value: true },
        },
        null
      )
    ).toBeNull()
  })
})
