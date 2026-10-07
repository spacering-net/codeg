import { createTranslator } from "next-intl"
import { describe, expect, it } from "vitest"

import en from "@/i18n/messages/en.json"
import {
  localizeConfigOptionLabel,
  localizeConfigOptions,
  localizeConfigValueLabel,
  localizeModeLabel,
  localizePermissionOptions,
  localizeSessionModes,
  type AgentVocabularyTranslator,
} from "@/lib/agent-label-vocabulary"
import type {
  PermissionOptionInfo,
  SessionConfigOptionInfo,
  SessionModeInfo,
} from "@/lib/types"

// The real production translator against the real catalogue: a key that is not
// in `en.json` fails here rather than silently rendering its own name.
const t = createTranslator({
  locale: "en",
  messages: en,
  namespace: "AgentVocabulary",
}) as AgentVocabularyTranslator

/** The modes `deepseek-acp` advertises, in its own (Simplified Chinese) words. */
function deepseekModes(): SessionModeInfo[] {
  return [
    {
      id: "default",
      name: "常规",
      description: "直接读写文件、执行命令完成任务",
    },
    { id: "plan", name: "计划", description: "先调研再给出完整方案" },
  ]
}

function selectOption(
  id: string,
  name: string,
  values: Array<[string, string]>,
  currentValue: string
): SessionConfigOptionInfo {
  return {
    id,
    name,
    description: null,
    category: null,
    kind: {
      type: "select",
      current_value: currentValue,
      options: values.map(([value, valueName]) => ({
        value,
        name: valueName,
        description: null,
      })),
      groups: [],
    },
  }
}

describe("session modes", () => {
  it("translates the ids DeepSeek advertises", () => {
    const [normal, plan] = localizeSessionModes("deepseek", deepseekModes(), t)
    expect(normal.name).toBe("Normal")
    expect(normal.description).toBe(
      "Reads and edits files and runs commands directly to get the job done"
    )
    expect(plan.name).toBe("Plan")
  })

  it("passes an unknown mode id through verbatim", () => {
    const modes: SessionModeInfo[] = [
      { id: "turbo", name: "涡轮", description: "上游明天加的" },
    ]
    expect(localizeSessionModes("deepseek", modes, t)).toBe(modes)
  })

  it("leaves other agents alone, by reference", () => {
    const modes = deepseekModes()
    expect(localizeSessionModes("codex", modes, t)).toBe(modes)
    expect(localizeSessionModes(null, modes, t)).toBe(modes)
  })

  it("resolves a lone mode id, falling back when unknown", () => {
    expect(localizeModeLabel("deepseek", "plan", "计划", t)).toBe("Plan")
    expect(localizeModeLabel("deepseek", "turbo", "涡轮", t)).toBe("涡轮")
    expect(localizeModeLabel("codex", "plan", "Plan mode", t)).toBe("Plan mode")
  })
})

describe("config options", () => {
  it("translates the option label and its values", () => {
    const [sandbox] = localizeConfigOptions(
      "deepseek",
      [
        selectOption(
          "sandbox",
          "文件权限",
          [
            ["read-only", "只读"],
            ["workspace-write", "可写工作区"],
            ["danger-full-access", "完全访问"],
          ],
          "workspace-write"
        ),
      ],
      t
    )
    expect(sandbox.name).toBe("File access")
    expect(sandbox.kind.type).toBe("select")
    if (sandbox.kind.type !== "select") throw new Error("unreachable")
    expect(sandbox.kind.options.map((o) => o.name)).toEqual([
      "Read-only",
      "Workspace write",
      "Full access (no sandbox)",
    ])
    // The value ids — what selection actually runs on — are untouched.
    expect(sandbox.kind.options.map((o) => o.value)).toEqual([
      "read-only",
      "workspace-write",
      "danger-full-access",
    ])
    expect(sandbox.kind.current_value).toBe("workspace-write")
  })

  it("replaces the agent's description, including any platform note, with one that keeps the caveat", () => {
    const withWindowsNote = selectOption(
      "sandbox",
      "文件权限",
      [["workspace-write", "可写工作区"]],
      "workspace-write"
    )
    if (withWindowsNote.kind.type !== "select") throw new Error("unreachable")
    withWindowsNote.kind.options[0].description =
      "写入意在限制于会话工作区。Windows 上是部分强制"
    const [localized] = localizeConfigOptions("deepseek", [withWindowsNote], t)
    if (localized.kind.type !== "select") throw new Error("unreachable")
    expect(localized.kind.options[0].description).toContain(
      "Enforcement can be partial on some platforms"
    )
  })

  it("translates the model option's LABEL but never the user's model catalogue", () => {
    const [model] = localizeConfigOptions(
      "deepseek",
      [
        selectOption(
          "model",
          "模型",
          [["deepseek-flash", "深度求索 Flash"]],
          "deepseek-flash"
        ),
      ],
      t
    )
    expect(model.name).toBe("Model")
    if (model.kind.type !== "select") throw new Error("unreachable")
    expect(model.kind.options[0].name).toBe("深度求索 Flash")
  })

  it("translates values inside groups too", () => {
    const grouped = selectOption("reasoning", "推理档位", [], "high")
    if (grouped.kind.type !== "select") throw new Error("unreachable")
    grouped.kind.groups = [
      {
        group: "g",
        name: "Group",
        options: [{ value: "high", name: "高", description: null }],
      },
    ]
    const [localized] = localizeConfigOptions("deepseek", [grouped], t)
    if (localized.kind.type !== "select") throw new Error("unreachable")
    expect(localized.kind.groups[0].options[0].name).toBe("High")
  })

  it("passes unknown options and unknown values through verbatim", () => {
    const options = [
      selectOption("telemetry", "遥测", [["on", "开"]], "on"),
      selectOption(
        "reasoning",
        "推理档位",
        [["ludicrous", "荒谬"]],
        "ludicrous"
      ),
    ]
    const localized = localizeConfigOptions("deepseek", options, t)
    expect(localized[0]).toBe(options[0])
    if (localized[1].kind.type !== "select") throw new Error("unreachable")
    expect(localized[1].kind.options[0].name).toBe("荒谬")
  })

  it("leaves a boolean option's shape intact", () => {
    const toggle: SessionConfigOptionInfo = {
      id: "sandbox",
      name: "文件权限",
      description: null,
      category: null,
      kind: { type: "boolean", current_value: true },
    }
    const [localized] = localizeConfigOptions("deepseek", [toggle], t)
    expect(localized.name).toBe("File access")
    expect(localized.kind).toEqual({ type: "boolean", current_value: true })
  })

  it("leaves other agents alone, by reference", () => {
    const options = [
      selectOption("sandbox", "文件权限", [["read-only", "只读"]], "read-only"),
    ]
    expect(localizeConfigOptions("codex", options, t)).toBe(options)
  })

  it("resolves lone option and value ids, falling back when unknown", () => {
    expect(
      localizeConfigOptionLabel("deepseek", "sandbox", "文件权限", t)
    ).toBe("File access")
    expect(localizeConfigOptionLabel("deepseek", "telemetry", "遥测", t)).toBe(
      "遥测"
    )
    expect(
      localizeConfigValueLabel("deepseek", "reasoning", "high", "高", t)
    ).toBe("High")
    // A value id is only ever read under its OWN option, so ids that collide
    // across options cannot cross over.
    expect(localizeConfigValueLabel("deepseek", "model", "high", "高", t)).toBe(
      "高"
    )
    expect(
      localizeConfigValueLabel("deepseek", "reasoning", null, "继承", t)
    ).toBe("继承")
    expect(
      localizeConfigValueLabel("codex", "sandbox", "read-only", "只读", t)
    ).toBe("只读")
  })
})

describe("permission options", () => {
  const options = (): PermissionOptionInfo[] => [
    { option_id: "allow-once", name: "允许本次", kind: "allow_once" },
    { option_id: "reject-once", name: "拒绝", kind: "reject_once" },
  ]

  it("translates the approval buttons", () => {
    expect(
      localizePermissionOptions("deepseek", options(), t).map((o) => o.name)
    ).toEqual(["Allow once", "Reject"])
  })

  it("keeps the option ids the response is sent with", () => {
    expect(
      localizePermissionOptions("deepseek", options(), t).map(
        (o) => o.option_id
      )
    ).toEqual(["allow-once", "reject-once"])
  })

  it("refuses to relabel when the ACP kind disagrees with the id", () => {
    const swapped: PermissionOptionInfo[] = [
      { option_id: "reject-once", name: "居然是放行", kind: "allow_once" },
    ]
    expect(localizePermissionOptions("deepseek", swapped, t)).toBe(swapped)
  })

  it("leaves other agents alone, by reference", () => {
    const claude = options()
    expect(localizePermissionOptions("claude_code", claude, t)).toBe(claude)
  })
})
