import { describe, expect, it } from "vitest"

import {
  buildSessionSettings,
  type SessionChoiceSetting,
  type SessionSetting,
  type SessionSwitchSetting,
} from "@/lib/session-settings"
import type {
  SessionConfigOptionInfo,
  SessionConfigSelectOptionInfo,
  SessionModeInfo,
} from "@/lib/types"

function select(
  id: string,
  name: string,
  category: string | null,
  current: string,
  options: (string | SessionConfigSelectOptionInfo)[],
  recommended: string | null = null
): SessionConfigOptionInfo {
  return {
    id,
    name,
    description: null,
    category,
    kind: {
      type: "select",
      current_value: current,
      options: options.map((o) =>
        typeof o === "string" ? { value: o, name: o, description: null } : o
      ),
      groups: [],
    },
    recommended_value: recommended,
  }
}

function boolean(id: string, name: string, on: boolean) {
  return {
    id,
    name,
    description: null,
    category: null,
    kind: { type: "boolean", current_value: on },
  } satisfies SessionConfigOptionInfo
}

function build(
  configOptions: SessionConfigOptionInfo[],
  modes: SessionModeInfo[] = [],
  currentModeId: string | null = null
): SessionSetting[] {
  return buildSessionSettings({
    configOptions,
    modes,
    currentModeId,
    modeTitle: "Mode",
  })
}

function choice(setting: SessionSetting | undefined): SessionChoiceSetting {
  if (!setting || setting.kind === "switch") throw new Error("not a choice")
  return setting
}

function toggle(setting: SessionSetting | undefined): SessionSwitchSetting {
  if (!setting || setting.kind !== "switch") throw new Error("not a switch")
  return setting
}

// What claude-agent-acp 0.88 advertises, in its own order.
const CLAUDE = [
  select("mode", "Mode", "mode", "default", [
    { value: "default", name: "Manual", description: "Always ask" },
    { value: "plan", name: "Plan", description: "Plan first" },
  ]),
  select(
    "model",
    "Model",
    "model",
    "opus",
    [
      { value: "opus", name: "Opus 5.5", description: "Best for everyday" },
      { value: "haiku", name: "Haiku 5.5", description: null },
    ],
    "opus"
  ),
  select(
    "effort",
    "Effort",
    "thought_level",
    "high",
    ["low", "medium", "high"],
    "medium"
  ),
  select("fast", "Fast mode", "model_config", "off", ["on", "off"]),
]

describe("buildSessionSettings — order", () => {
  it("puts the model first, then effort, then mode, other selects, switches", () => {
    // codex-acp 2.2.2's order: mode, collaboration mode, model, effort, fast.
    const settings = build([
      select("mode", "Mode", "mode", "agent", ["read-only", "agent"]),
      select(
        "collaboration_mode",
        "Collaboration mode",
        "collaboration_mode",
        "default",
        ["default", "plan"]
      ),
      select("fast_mode", "Fast mode", "model_config", "on", ["off", "on"]),
      select("model", "Model", "model", "gpt-6", ["gpt-6", "gpt-5"]),
      select("reasoning_effort", "Reasoning effort", "thought_level", "low", [
        "low",
        "high",
      ]),
    ])
    expect(settings.map((s) => s.key)).toEqual([
      "config:model",
      "config:reasoning_effort",
      "config:mode",
      "config:collaboration_mode",
      "config:fast_mode",
    ])
  })

  it("keeps the agent's order within a rank", () => {
    // Cline 3.0.62: both Provider and Model are `category: "model"`.
    const settings = build([
      select("provider", "Provider", "model", "cline", ["cline", "anthropic"]),
      select("model", "Model", "model", "a", ["a", "b"]),
      boolean("auto_approve", "Auto-approve tools", true),
      select("mode", "Session Mode", "mode", "act", ["plan", "act"]),
    ])
    expect(settings.map((s) => s.key)).toEqual([
      "config:provider",
      "config:model",
      "config:mode",
      "config:auto_approve",
    ])
  })

  it("ranks the legacy mode list as a mode", () => {
    const settings = build(
      [],
      [
        { id: "default", name: "Default", description: "Prompts" },
        { id: "yolo", name: "YOLO", description: null },
      ],
      "yolo"
    )
    const mode = choice(settings[0])
    expect(mode.target).toEqual({ type: "mode" })
    expect(mode.title).toBe("Mode")
    expect(mode.currentLabel).toBe("YOLO")
    expect(mode.summary).toBe("YOLO")
  })
})

describe("buildSessionSettings — summary", () => {
  it("leaves out a `default` value and a switch that is off", () => {
    const settings = build(CLAUDE)
    expect(settings.map((s) => s.summary)).toEqual([
      "Opus 5.5",
      "high",
      null, // mode `default` (Manual)
      null, // fast mode off
    ])
  })

  it("names a switch by its title while it is on", () => {
    const settings = build([
      ...CLAUDE.slice(0, 3),
      select("fast", "Fast mode", "model_config", "on", ["on", "off"]),
      boolean("auto_approve", "Auto-approve tools", true),
    ])
    expect(settings.map((s) => s.summary)).toEqual([
      "Opus 5.5",
      "high",
      null,
      "Fast mode",
      "Auto-approve tools",
    ])
  })

  it("always shows the model, even one whose value is `default`", () => {
    // claude-agent-acp before 0.76 keeps a `default` model row.
    const settings = build([
      select("model", "Model", null, "default", [
        { value: "default", name: "Default (recommended)", description: null },
        { value: "opus", name: "Opus", description: null },
      ]),
      select("effort", "Effort", "thought_level", "default", [
        "default",
        "max",
      ]),
      // A shown value elsewhere, so the all-omitted fallback stays out of it.
      select("mode", "Mode", "mode", "plan", ["default", "plan"]),
    ])
    expect(settings.map((s) => s.summary)).toEqual([
      "Default (recommended)",
      null,
      "plan",
    ])
  })

  it("falls back to the first value when everything was left out", () => {
    // Gemini CLI: only its legacy modes, on `default`.
    const settings = build(
      [],
      [
        { id: "default", name: "Default", description: "Prompts for approval" },
        { id: "plan", name: "Plan", description: "Read-only mode" },
      ],
      "default"
    )
    expect(settings.map((s) => s.summary)).toEqual(["Default"])
  })

  it("never falls back onto a switch", () => {
    const settings = build([
      boolean("auto_approve", "Auto-approve tools", false),
    ])
    expect(settings.map((s) => s.summary)).toEqual([null])
  })
})

describe("buildSessionSettings — controls", () => {
  it("makes the model a list and a short select a segmented control", () => {
    const [model, effort, mode] = build(CLAUDE)
    expect(choice(model).kind).toBe("list")
    expect(choice(model).searchable).toBe(false)
    expect(choice(effort).kind).toBe("segmented")
    expect(choice(mode).kind).toBe("segmented")
  })

  it("searches a model list longer than eight", () => {
    const options = Array.from({ length: 9 }, (_, i) => `m${i}`)
    const [model] = build([select("model", "Model", "model", "m0", options)])
    expect(choice(model).kind).toBe("list")
    expect(choice(model).searchable).toBe(true)
  })

  it("turns any select longer than eight into a searchable list", () => {
    const eight = Array.from({ length: 8 }, (_, i) => `v${i}`)
    const nine = [...eight, "v8"]
    expect(choice(build([select("a", "A", null, "v0", eight)])[0]).kind).toBe(
      "segmented"
    )
    const long = choice(build([select("a", "A", null, "v0", nine)])[0])
    expect(long.kind).toBe("list")
    expect(long.searchable).toBe(true)
  })

  it("reads a boolean option as a switch that sends true/false", () => {
    const setting = toggle(build([boolean("auto_approve", "Auto", false)])[0])
    expect(setting).toMatchObject({
      checked: false,
      onValue: "true",
      offValue: "false",
    })
  })

  it("reads an on/off select as a switch, keeping the agent's own values", () => {
    const fast = toggle(
      build([select("fast", "Fast", null, "On", ["Off", "On"])])[0]
    )
    expect(fast).toMatchObject({
      checked: true,
      onValue: "On",
      offValue: "Off",
    })
    const flag = toggle(
      build([select("flag", "Flag", null, "false", ["true", "false"])])[0]
    )
    expect(flag).toMatchObject({
      checked: false,
      onValue: "true",
      offValue: "false",
    })
  })

  it("keeps an on/off select segmented while its value is neither", () => {
    // Kiro's thinking toggle reports `default` until a state is set; a switch
    // would claim "off" for it.
    const [, thinking] = build([
      select("model", "Model", "model", "k", ["k"]),
      select("thinking", "Thinking", "thought_level", "default", ["on", "off"]),
    ])
    expect(thinking.kind).toBe("segmented")
    expect(thinking.summary).toBeNull()
  })

  it("does not read a three-value select as a switch", () => {
    const [setting] = build([
      select("fast", "Fast", null, "on", ["on", "off", "auto"]),
    ])
    expect(setting.kind).toBe("segmented")
  })
})

describe("buildSessionSettings — values", () => {
  it("labels a grouped model by its prefix-stripped name", () => {
    const [model] = build([
      select("model", "Model", "model", "anthropic/claude-opus", [
        "anthropic/claude-opus",
        "openai/gpt-4o",
      ]),
    ])
    const setting = choice(model)
    expect(setting.groups.map((g) => g.name)).toEqual(["anthropic", "openai"])
    expect(setting.currentLabel).toBe("claude-opus")
    expect(setting.summary).toBe("claude-opus")
    // The value itself is never rewritten.
    expect(setting.currentValue).toBe("anthropic/claude-opus")
  })

  it("carries the current description and the recommendation", () => {
    const [model, effort] = build(CLAUDE)
    expect(choice(model).currentDescription).toBe("Best for everyday")
    expect(choice(model).recommendedValue).toBe("opus")
    expect(choice(effort).recommendedValue).toBe("medium")
  })

  it("falls back to the raw value when it names no option", () => {
    const [model] = build([select("model", "Model", "model", "gone", ["a"])])
    expect(choice(model).currentLabel).toBe("gone")
    expect(choice(model).summary).toBe("gone")
  })

  it("targets config options by id", () => {
    const [model] = build(CLAUDE)
    expect(model.target).toEqual({ type: "config", configId: "model" })
  })
})

describe("MiniMax Code ACP model settings", () => {
  it("uses the native model config option rather than a legacy model setter", () => {
    const settings = build([
      select("model", "Model", "model", "m:minimax:MiniMax-M2.7:u", [
        "m:minimax:MiniMax-M2.7:u",
        "m:custom%3Aprovider:vendor%2Fmodel:v:fast",
      ]),
    ])
    const model = choice(settings[0])
    expect(model.isModel).toBe(true)
    expect(model.currentValue).toBe("m:minimax:MiniMax-M2.7:u")
    expect(model.target).toEqual({ type: "config", configId: "model" })
    expect(model.groups[0].options.map((option) => option.value)).toEqual([
      "m:minimax:MiniMax-M2.7:u",
      "m:custom%3Aprovider:vendor%2Fmodel:v:fast",
    ])
  })
})
