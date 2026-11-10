import { describe, expect, it } from "vitest"

import {
  delegatesPermission,
  delegatesPlan,
  delegatesQuestion,
  isPlanPermission,
} from "./ask-delegate"

const opt = (option_id: string) => ({ option_id })

describe("isPlanPermission", () => {
  it("knows Claude Code's ExitPlanMode by its exit-plan options", () => {
    expect(
      isPlanPermission({ kind: "switch_mode" }, [
        opt("exit-plan-auto"),
        opt("exit-plan-default"),
        opt("reject"),
      ])
    ).toBe(true)
  })

  it("knows a Codex plan review by its id or its implement option", () => {
    expect(isPlanPermission({ toolCallId: "plan-review:item-7" }, [])).toBe(
      true
    )
    expect(isPlanPermission({ tool_call_id: "plan-review:x" }, null)).toBe(true)
    expect(
      isPlanPermission({ toolCallId: "call_1" }, [
        opt("implement_plan"),
        opt("revise_plan"),
      ])
    ).toBe(true)
  })

  it("leaves every other permission request alone", () => {
    expect(
      isPlanPermission({ kind: "execute", toolCallId: "call_1" }, [
        opt("allow-once"),
        opt("reject"),
      ])
    ).toBe(false)
    // EnterPlanMode is a mode switch too, but not a plan to approve.
    expect(
      isPlanPermission({ kind: "switch_mode", toolCallId: "call_2" }, [
        opt("allow-once"),
        opt("reject"),
      ])
    ).toBe(false)
    expect(isPlanPermission(null, undefined)).toBe(false)
  })
})

describe("what the assistant answers", () => {
  const both = { bot_id: 1, questions: true, plans: true }
  it("questions, but not one asking for a secret", () => {
    expect(delegatesQuestion(both, [{ is_secret: false }])).toBe(true)
    expect(delegatesQuestion(both, [{}, { is_secret: true }])).toBe(false)
    expect(delegatesQuestion({ ...both, questions: false }, [])).toBe(false)
    expect(delegatesQuestion(null, [])).toBe(false)
  })

  it("plans, of either kind, and only those", () => {
    expect(delegatesPlan(both)).toBe(true)
    expect(delegatesPlan({ ...both, plans: false })).toBe(false)
    expect(delegatesPermission(both, {}, [opt("exit-plan-default")])).toBe(true)
    expect(delegatesPermission(both, {}, [opt("allow-once")])).toBe(false)
    expect(
      delegatesPermission({ ...both, plans: false }, {}, [
        opt("exit-plan-auto"),
      ])
    ).toBe(false)
  })
})
