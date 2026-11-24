import { describe, expect, it } from "vitest"

import {
  buildCursorModelFamilies,
  decomposeCursorModelId,
  defaultCursorVariant,
  familyEffortValues,
  familyFastValues,
  familyThinkingValues,
  resolveCursorVariant,
  variantKey,
  type CursorModelEntry,
} from "./cursor-model-variants"

/** A slice of the real `cursor-agent models` output (2026.08.11). Claude Opus 5
 *  is the interesting family: xhigh/max exist ONLY with thinking on, which is
 *  what makes a naive "all combinations" picker wrong. */
const CATALOG: CursorModelEntry[] = [
  { id: "auto", label: "Auto", isDefault: true },
  { id: "composer-2.5", label: "Composer 2.5", isDefault: false },
  { id: "composer-2.5-fast", label: "Composer 2.5 Fast", isDefault: false },
  { id: "claude-opus-5-low", label: "Claude Opus 5 1M Low", isDefault: false },
  {
    id: "claude-opus-5-low-fast",
    label: "Claude Opus 5 1M Low Fast",
    isDefault: false,
  },
  { id: "claude-opus-5-high", label: "Claude Opus 5 1M", isDefault: false },
  {
    id: "claude-opus-5-high-fast",
    label: "Claude Opus 5 1M Fast",
    isDefault: false,
  },
  {
    id: "claude-opus-5-thinking-high",
    label: "Claude Opus 5 1M Thinking",
    isDefault: false,
  },
  {
    id: "claude-opus-5-thinking-xhigh",
    label: "Claude Opus 5 1M Extra High Thinking",
    isDefault: false,
  },
  {
    id: "claude-opus-5-thinking-max",
    label: "Claude Opus 5 1M Max Thinking",
    isDefault: false,
  },
  {
    id: "claude-opus-5-thinking-max-fast",
    label: "Claude Opus 5 1M Max Thinking Fast",
    isDefault: false,
  },
]

const familyOf = (base: string) => {
  const family = buildCursorModelFamilies(CATALOG).find((f) => f.base === base)
  if (!family) throw new Error(`no family ${base}`)
  return family
}

describe("decomposeCursorModelId", () => {
  it("peels fast, then effort, then thinking", () => {
    expect(decomposeCursorModelId("claude-opus-5-thinking-max-fast")).toEqual({
      base: "claude-opus-5",
      variant: { thinking: true, effort: "max", fast: true },
    })
    expect(decomposeCursorModelId("gpt-5.3-codex-xhigh")).toEqual({
      base: "gpt-5.3-codex",
      variant: { thinking: false, effort: "xhigh", fast: false },
    })
    expect(decomposeCursorModelId("composer-2.5-fast")).toEqual({
      base: "composer-2.5",
      variant: { thinking: false, effort: null, fast: true },
    })
  })

  it("leaves an id with no variant suffix alone", () => {
    expect(decomposeCursorModelId("auto")).toEqual({
      base: "auto",
      variant: { thinking: false, effort: null, fast: false },
    })
    // `-5` is not an effort token, so a version-suffixed name stays whole.
    expect(decomposeCursorModelId("gemini-3.1-pro").base).toBe("gemini-3.1-pro")
  })

  it("does not mistake a bare effort word for a suffix", () => {
    // No dash to split on: the whole thing is the base, not "" at max effort.
    expect(decomposeCursorModelId("max").base).toBe("max")
  })
})

describe("buildCursorModelFamilies", () => {
  it("groups by base and keeps the catalog's order", () => {
    const families = buildCursorModelFamilies(CATALOG)
    expect(families.map((f) => f.base)).toEqual([
      "auto",
      "composer-2.5",
      "claude-opus-5",
    ])
  })

  it("labels a family with the display name its members share", () => {
    expect(familyOf("claude-opus-5").label).toBe("Claude Opus 5 1M")
    expect(familyOf("composer-2.5").label).toBe("Composer 2.5")
    expect(familyOf("auto").label).toBe("Auto")
  })

  it("carries the default flag up to the family", () => {
    expect(familyOf("auto").isDefault).toBe(true)
    expect(familyOf("claude-opus-5").isDefault).toBe(false)
  })

  it("only ever exposes ids the catalog reported", () => {
    const family = familyOf("claude-opus-5")
    const catalogIds = new Set(CATALOG.map((m) => m.id))
    for (const entry of family.variants.values()) {
      expect(catalogIds.has(entry.id)).toBe(true)
    }
    // `thinking + low` is NOT in the catalog and must not be invented.
    expect(
      family.variants.get(
        variantKey({ thinking: true, effort: "low", fast: false })
      )
    ).toBeUndefined()
  })
})

describe("family dimension values", () => {
  it("reports only the values that exist", () => {
    const opus = familyOf("claude-opus-5")
    expect(familyThinkingValues(opus)).toEqual([false, true])
    expect(familyEffortValues(opus)).toEqual(["low", "high", "xhigh", "max"])
    expect(familyFastValues(opus)).toEqual([false, true])

    // Composer varies on Fast alone — the other two controls stay hidden.
    const composer = familyOf("composer-2.5")
    expect(familyThinkingValues(composer)).toEqual([false])
    expect(familyEffortValues(composer)).toEqual([null])
    expect(familyFastValues(composer)).toEqual([false, true])
  })
})

describe("resolveCursorVariant", () => {
  const opus = familyOf("claude-opus-5")

  it("returns the exact member when the combination exists", () => {
    expect(
      resolveCursorVariant(opus, {
        thinking: true,
        effort: "max",
        fast: true,
      })?.id
    ).toBe("claude-opus-5-thinking-max-fast")
  })

  it("holds the dimension the user moved and clamps the rest", () => {
    // Thinking off at max effort does not exist. The user moved `thinking`, so
    // thinking stays off and the effort drops to the nearest one that ships.
    expect(
      resolveCursorVariant(
        opus,
        { thinking: false, effort: "max", fast: false },
        "thinking"
      )?.id
    ).toBe("claude-opus-5-high")

    // …and moving `effort` instead keeps the effort and turns thinking on.
    expect(
      resolveCursorVariant(
        opus,
        { thinking: false, effort: "max", fast: false },
        "effort"
      )?.id
    ).toBe("claude-opus-5-thinking-max")
  })

  it("keeps the reasoning mode ahead of the speed flag when repairing", () => {
    // thinking+xhigh+fast is absent. Dropping Fast preserves both the thinking
    // mode and the effort, which beats dropping either of those.
    expect(
      resolveCursorVariant(
        opus,
        { thinking: true, effort: "xhigh", fast: true },
        "effort"
      )?.id
    ).toBe("claude-opus-5-thinking-xhigh")
  })

  it("falls back past an unsatisfiable pin rather than returning nothing", () => {
    const composer = familyOf("composer-2.5")
    // composer has no effort axis at all; pinning one still yields a real id.
    expect(
      resolveCursorVariant(
        composer,
        { thinking: false, effort: "max", fast: true },
        "effort"
      )?.id
    ).toBe("composer-2.5-fast")
  })
})

describe("defaultCursorVariant", () => {
  it("prefers the catalog default, else the first member", () => {
    expect(defaultCursorVariant(familyOf("auto"))).toEqual({
      thinking: false,
      effort: null,
      fast: false,
    })
    expect(defaultCursorVariant(familyOf("claude-opus-5"))).toEqual({
      thinking: false,
      effort: "low",
      fast: false,
    })
  })
})
