import { createTranslator } from "next-intl"
import { describe, expect, it } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"
import type { StepLine } from "@/lib/types"

import {
  activityText,
  doingText,
  doneText,
  stepText,
  WAIT_AFTER_MS,
  type Translate,
} from "./activity-text"

const en = createTranslator({
  locale: "en",
  messages: enMessages,
  namespace: "PersonalAgent",
}) as unknown as Translate
const zh = createTranslator({
  locale: "zh-CN",
  messages: zhMessages,
  namespace: "PersonalAgent",
}) as unknown as Translate

const NOW = Date.parse("2026-11-10T12:00:00Z")

function step(patch: Partial<StepLine>): StepLine {
  return {
    n: 1,
    kind: "other",
    started_at: new Date(NOW).toISOString(),
    status: "in_progress",
    ...patch,
  }
}

describe("what it is doing", () => {
  it("names the file, the query, whom the work went to", () => {
    expect(doingText(zh, step({ kind: "edit", target: "startup.rs" }))).toBe(
      "正在改 startup.rs"
    )
    expect(doingText(zh, step({ kind: "read", target: "AGENTS.md" }))).toBe(
      "正在读 AGENTS.md"
    )
    expect(doingText(zh, step({ kind: "search", target: "toFixed" }))).toBe(
      "正在找“toFixed”"
    )
    expect(
      doingText(zh, step({ kind: "dispatch", target: "Claude Code" }))
    ).toBe("正在交给 Claude Code")
    expect(doingText(zh, step({ kind: "message", target: "阿审" }))).toBe(
      "正在问 阿审"
    )
    expect(doingText(en, step({ kind: "test" }))).toBe("Running the tests")
  })

  it("keeps one wording of a vague step through a turn, and turns to waiting on a long command", () => {
    const think = step({ kind: "think" })
    const a = doingText(zh, think, { turn: 7 })
    expect(doingText(zh, think, { turn: 7 })).toBe(a)
    expect(
      new Set([0, 1, 2].map((turn) => doingText(zh, think, { turn }))).size
    ).toBe(3)
    const run = step({ kind: "execute" })
    expect(doingText(zh, run, { now: NOW + 1000 })).toBe("正在跑几条命令")
    expect(doingText(zh, run, { now: NOW + WAIT_AFTER_MS + 1 })).toBe(
      "正在等结果"
    )
  })

  it("says it needs the owner while it waits on them", () => {
    expect(
      doingText(zh, step({ kind: "execute", awaiting: true, target: "rm" }))
    ).toBe("需要你批准")
    expect(doingText(zh, step({ kind: "question", awaiting: true }))).toBe(
      "需要你回答"
    )
  })

  it("puts the work it is from in front", () => {
    expect(
      activityText(
        zh,
        {
          step: step({ kind: "edit", target: "startup.rs" }),
          work: { dispatch_id: 234, title: "修冷启动白屏" },
        },
        NOW
      )
    ).toBe("#234 修冷启动白屏：正在改 startup.rs")
  })
})

describe("what it did", () => {
  it("says the action, the object and a number", () => {
    const done = { status: "completed" }
    expect(
      doneText(
        zh,
        step({
          ...done,
          kind: "edit",
          target: "parser.rs",
          added: 14,
          removed: 10,
        })
      )
    ).toBe("改了 parser.rs +14 −10")
    expect(doneText(zh, step({ ...done, kind: "test", passed: 212 }))).toBe(
      "跑完测试 212 通过"
    )
    expect(doneText(zh, step({ ...done, kind: "test", exit_code: 0 }))).toBe(
      "跑完测试，退出码 0"
    )
    expect(
      doneText(
        zh,
        step({
          status: "failed",
          kind: "execute",
          target: "pnpm lint",
          exit_code: 1,
        })
      )
    ).toBe("跑了 pnpm lint，退出码 1")
    expect(
      doneText(
        zh,
        step({ ...done, kind: "search", target: "toFixed", hits: 12 })
      )
    ).toBe("找了“toFixed”，12 处")
    expect(
      doneText(zh, step({ ...done, kind: "commit", target: "clamp NaN" }))
    ).toBe("提交了：clamp NaN")
    expect(
      doneText(
        zh,
        step({
          ...done,
          kind: "dispatch",
          target: "Claude Code",
          dispatch_id: 234,
        })
      )
    ).toBe("交给了 Claude Code：#234")
    expect(
      doneText(en, step({ ...done, kind: "message", target: "Reviewer" }))
    ).toBe("Sent a message to Reviewer")
  })

  it("lists a step by what it did once it ended, and by what it does till then", () => {
    expect(stepText(zh, step({ kind: "read", target: "a.md" }), NOW)).toBe(
      "正在读 a.md"
    )
    expect(
      stepText(zh, step({ kind: "read", target: "a.md", status: "completed" }))
    ).toBe("读了 a.md")
  })
})
