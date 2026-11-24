import { describe, expect, it } from "vitest"

import {
  applyCodexCompatOverrides,
  CODEX_COMPAT_OVERRIDES,
  hasCodexCustomization,
  isCodexCompatEntry,
  parseCodexModelConfig,
  pruneCodexGhostExclusions,
  serializeCodexModelConfig,
  type CodexCustomEntry,
  type CodexModelConfig,
  type CodexModelInfo,
} from "@/lib/types"

describe("Codex structured model config", () => {
  it("round-trips customs + excludedOfficials + default", () => {
    const config: CodexModelConfig = {
      customs: [
        {
          slug: "gw/opus",
          displayName: "Gateway Opus",
          contextWindow: 200000,
          base: "gpt-5.6-sol",
          overrides: { description: "x" },
        },
      ],
      excludedOfficials: ["gpt-5.2"],
      default: "gw/opus",
    }
    const serialized = serializeCodexModelConfig(config)
    expect(serialized).not.toBeNull()
    expect(parseCodexModelConfig(serialized)).toEqual(config)
  })

  // The edit dialog diffs `provider.model !== serialize(state)`; a load→no-edit
  // cycle must reproduce the exact stored string or it reports a spurious change.
  it("is idempotent (serialize∘parse is identity on canonical JSON)", () => {
    const raw = serializeCodexModelConfig({
      customs: [{ slug: "a", base: "gpt-5.4", overrides: { b: 1, a: 2 } }],
      excludedOfficials: ["z", "a"],
      default: "a",
    })!
    expect(serializeCodexModelConfig(parseCodexModelConfig(raw))).toBe(raw)
  })

  it("sorts override keys and excludedOfficials for a byte-stable diff", () => {
    const s = serializeCodexModelConfig({
      customs: [
        { slug: "a", base: "b", overrides: { z: 1, a: 2, m: { y: 1, x: 2 } } },
      ],
      excludedOfficials: ["gpt-b", "gpt-a"],
    })
    expect(s).toBe(
      JSON.stringify({
        customs: [
          {
            slug: "a",
            base: "b",
            overrides: { a: 2, m: { x: 2, y: 1 }, z: 1 },
          },
        ],
        excludedOfficials: ["gpt-a", "gpt-b"],
      })
    )
  })

  it("migrates a legacy {models} catalog to customs", () => {
    expect(
      parseCodexModelConfig(
        JSON.stringify({
          models: [{ slug: "gw/x", base: "gpt-5.4" }],
          default: "gw/x",
        })
      )
    ).toEqual({ customs: [{ slug: "gw/x", base: "gpt-5.4" }], default: "gw/x" })
  })

  it("treats a legacy plain slug as a single custom", () => {
    expect(parseCodexModelConfig("gpt-5.5")).toEqual({
      customs: [{ slug: "gpt-5.5", base: "gpt-5.5" }],
      default: "gpt-5.5",
    })
  })

  it("empty/no-deviation inputs → empty config; serializes to null", () => {
    expect(parseCodexModelConfig(null)).toEqual({ customs: [] })
    expect(parseCodexModelConfig("   ")).toEqual({ customs: [] })
    expect(parseCodexModelConfig('{"customs":[]}')).toEqual({ customs: [] })
    // No customs AND no removed officials → feature off → null.
    expect(serializeCodexModelConfig({ customs: [] })).toBeNull()
    // But removing an official alone is a real deviation → not null.
    expect(
      serializeCodexModelConfig({ customs: [], excludedOfficials: ["gpt-5.2"] })
    ).toBe(JSON.stringify({ customs: [], excludedOfficials: ["gpt-5.2"] }))
  })

  it("preserves a default that names an official (validated later by the backend)", () => {
    const s = serializeCodexModelConfig({
      customs: [{ slug: "a", base: "b" }],
      default: "gpt-5.5",
    })
    expect(s).toBe(
      JSON.stringify({
        customs: [{ slug: "a", base: "b" }],
        default: "gpt-5.5",
      })
    )
  })

  it("skips customs missing a slug and defaults base to the slug", () => {
    const parsed = parseCodexModelConfig(
      JSON.stringify({ customs: [{ base: "b" }, { slug: "keep" }] })
    )
    expect(parsed).toEqual({ customs: [{ slug: "keep", base: "keep" }] })
  })
})

// Mirrors codex 0.147: it retired gpt-5.4 / gpt-5.4-mini by flipping them to
// `hide` rather than deleting them, which is what turns an old removal into a
// ghost.
const CATALOG: CodexModelInfo[] = [
  { slug: "gpt-5.6-sol", visibility: "list" },
  { slug: "gpt-5.5", visibility: "list" },
  { slug: "gpt-5.2", visibility: "list" },
  { slug: "gpt-5.4", visibility: "hide" },
  { slug: "gpt-5.4-mini", visibility: "hide" },
]

describe("Codex model list source", () => {
  it("round-trips a provider source in a fixed shape", () => {
    const config: CodexModelConfig = {
      customs: [],
      default: "glm-5.2",
      catalog: {
        url: "https://relay.example/v1/models",
        format: "openai_list",
        selected: ["glm-5.2", "kimi-k3"],
      },
    }
    const raw = serializeCodexModelConfig(config)
    expect(raw).toBe(
      '{"customs":[],"default":"glm-5.2","catalog":{"url":"https://relay.example/v1/models","format":"openai_list","selected":["glm-5.2","kimi-k3"]}}'
    )
    expect(parseCodexModelConfig(raw)).toEqual(config)
    expect(serializeCodexModelConfig(parseCodexModelConfig(raw))).toBe(raw)
  })

  // "From the provider" with nothing else set is still a choice to keep.
  it("keeps a source with no customs, no removals and no picks", () => {
    const raw = serializeCodexModelConfig({ customs: [], catalog: {} })
    expect(raw).toBe('{"customs":[],"catalog":{}}')
    expect(parseCodexModelConfig(raw).catalog).toEqual({})
    expect(hasCodexCustomization(parseCodexModelConfig(raw), [])).toBe(true)
  })

  it("keeps the picks in the user's order, once each", () => {
    const config = parseCodexModelConfig(
      JSON.stringify({
        customs: [],
        catalog: { selected: [" b ", "a", "b", "", 3], format: "xml" },
      })
    )
    expect(config.catalog).toEqual({ selected: ["b", "a"] })
  })

  it("drops a source that is not an object", () => {
    expect(
      parseCodexModelConfig('{"customs":[],"catalog":"yes"}').catalog
    ).toBeUndefined()
  })
})

describe("Codex ghost exclusions", () => {
  it("drops removals of officials codex no longer lists", () => {
    expect(
      pruneCodexGhostExclusions(
        { customs: [], excludedOfficials: ["gpt-5.4", "gpt-5.4-mini"] },
        CATALOG
      )
    ).toEqual({ customs: [] })
  })

  it("keeps removals that still apply, alongside ghosts", () => {
    expect(
      pruneCodexGhostExclusions(
        { customs: [], excludedOfficials: ["gpt-5.4", "gpt-5.2"] },
        CATALOG
      )
    ).toEqual({ customs: [], excludedOfficials: ["gpt-5.2"] })
  })

  // An unavailable catalog means "we can't tell", never "the user removed
  // nothing" — pruning there would silently discard real intent.
  it("leaves the config untouched when the catalog hasn't loaded", () => {
    const config: CodexModelConfig = {
      customs: [],
      excludedOfficials: ["gpt-5.4"],
    }
    expect(pruneCodexGhostExclusions(config, [])).toBe(config)
  })

  it("returns the same object when there is nothing to prune", () => {
    const config: CodexModelConfig = {
      customs: [],
      excludedOfficials: ["gpt-5.2"],
    }
    expect(pruneCodexGhostExclusions(config, CATALOG)).toBe(config)
  })

  // The regression this fixes: a user with no custom models saw the "you've
  // customized the model list" banner forever, because two long-retired
  // removals still counted.
  it("only reports customization that actually applies", () => {
    expect(
      hasCodexCustomization(
        { customs: [], excludedOfficials: ["gpt-5.4", "gpt-5.4-mini"] },
        CATALOG
      )
    ).toBe(false)
    expect(
      hasCodexCustomization(
        { customs: [], excludedOfficials: ["gpt-5.2"] },
        CATALOG
      )
    ).toBe(true)
    expect(
      hasCodexCustomization({ customs: [{ slug: "a", base: "b" }] }, CATALOG)
    ).toBe(true)
    expect(hasCodexCustomization({ customs: [] }, CATALOG)).toBe(false)
  })
})

describe("Codex OpenAI-compatible template", () => {
  const gptBase: Record<string, unknown> = {
    tool_mode: "code_mode_only",
    multi_agent_version: "v2",
    use_responses_lite: true,
    apply_patch_tool_type: "freeform",
    supports_image_detail_original: true,
  }
  const entry: CodexCustomEntry = { slug: "gw/x", base: "gpt-5.6-sol" }

  it("writes every compat key that differs from the base", () => {
    const overrides = applyCodexCompatOverrides(entry, gptBase, true)
    expect(overrides).toEqual(CODEX_COMPAT_OVERRIDES)
    expect(isCodexCompatEntry({ ...entry, overrides }, gptBase)).toBe(true)
  })

  // Sparse-write rule: a value already equal to the base carries no override,
  // so `serialize` stays byte-stable and the form doesn't report a fake change.
  it("stores nothing for a base that is already compatible", () => {
    const compatBase = { ...gptBase, ...CODEX_COMPAT_OVERRIDES }
    expect(applyCodexCompatOverrides(entry, compatBase, true)).toBeUndefined()
    // …and such an entry still reads as compatible, from the base alone.
    expect(isCodexCompatEntry(entry, compatBase)).toBe(true)
  })

  it("preserves unrelated overrides and clears only the bundle", () => {
    const withExtras: CodexCustomEntry = {
      ...entry,
      overrides: { ...CODEX_COMPAT_OVERRIDES, description: "mine" },
    }
    expect(applyCodexCompatOverrides(withExtras, gptBase, false)).toEqual({
      description: "mine",
    })
    expect(
      isCodexCompatEntry(
        { ...entry, overrides: { description: "mine" } },
        gptBase
      )
    ).toBe(false)
  })

  it("does not call a half-applied entry compatible", () => {
    expect(
      isCodexCompatEntry(
        { ...entry, overrides: { tool_mode: null, use_responses_lite: false } },
        gptBase
      )
    ).toBe(false)
  })
})
