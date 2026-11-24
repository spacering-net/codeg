import { describe, expect, it } from "vitest"

import { getAgentColor, getAgentLabel } from "@/lib/custom-agents"
import {
  AGENT_DISPLAY_ORDER,
  ALL_AGENT_TYPES,
  compareAgentType,
  isCustomAgentType,
} from "@/lib/types"

describe("MiniMax Code built-in identity", () => {
  it("appears exactly once in the built-in selection and display lists", () => {
    expect(ALL_AGENT_TYPES.filter((type) => type === "minimax_code")).toEqual([
      "minimax_code",
    ])
    expect(
      AGENT_DISPLAY_ORDER.filter((type) => type === "minimax_code")
    ).toEqual(["minimax_code"])
    expect(isCustomAgentType("minimax_code")).toBe(false)
    expect(compareAgentType("minimax_code", "custom:test")).toBeLessThan(0)
  })

  it("has a stable name and color without a custom-agent registration", () => {
    expect(getAgentLabel("minimax_code")).toBe("MiniMax Code")
    expect(getAgentColor("minimax_code")).toBe("bg-[#F23F5D]")
  })
})
