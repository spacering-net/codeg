import { describe, expect, it } from "vitest"

import {
  deriveModelGroups,
  filterModelGroups,
  flattenModelGroups,
  isModelConfigOption,
  modelListGroups,
  type ModelOptionGroup,
} from "./model-config-groups"
import type {
  SessionConfigOptionInfo,
  SessionConfigSelectOptionInfo,
} from "@/lib/types"

// Returns the option with its `kind` narrowed to the select arm, so tests can
// keep poking at `kind.groups` / `kind.options` directly.
function modelOption(
  options: SessionConfigSelectOptionInfo[],
  overrides: Partial<Omit<SessionConfigOptionInfo, "kind">> = {}
): SessionConfigOptionInfo & {
  kind: Extract<SessionConfigOptionInfo["kind"], { type: "select" }>
} {
  return {
    id: "model",
    name: "Model",
    description: null,
    category: null,
    kind: {
      type: "select",
      current_value: options[0]?.value ?? "",
      options,
      groups: [],
    },
    ...overrides,
  }
}

function opt(
  value: string,
  name = value,
  description: string | null = null
): SessionConfigSelectOptionInfo {
  return { value, name, description }
}

describe("isModelConfigOption", () => {
  it("matches the model option by id", () => {
    expect(isModelConfigOption(modelOption([opt("a")]))).toBe(true)
  })

  it("matches by category when id differs", () => {
    expect(
      isModelConfigOption(
        modelOption([opt("a")], { id: "primary-model", category: "model" })
      )
    ).toBe(true)
  })

  it("rejects the mode picker and other options", () => {
    expect(
      isModelConfigOption(
        modelOption([opt("a")], { id: "mode", category: "mode" })
      )
    ).toBe(false)
    expect(isModelConfigOption(modelOption([opt("a")], { id: "effort" }))).toBe(
      false
    )
  })
})

describe("deriveModelGroups", () => {
  it("groups OpenCode's Magpie wrapper by its catalog sources", () => {
    const option = modelOption([
      opt("magpie/auto/fast", "Magpie via Headroom/Fast", "Routing group"),
      opt("magpie/opencode-go/vendor/model:1", "Magpie via Headroom/Model"),
      opt("magpie/openai/model", "Magpie via Headroom/Other model"),
      opt("magpie/auto/smart", "Magpie via Headroom/Smart"),
    ])
    const groups = deriveModelGroups(option)!
    expect(groups?.map((group) => group.name)).toEqual([
      "auto",
      "opencode-go",
      "openai",
    ])
    expect(groups[0].options).toEqual([
      opt("magpie/auto/fast", "Fast", "Routing group"),
      opt("magpie/auto/smart", "Smart"),
    ])
    expect(groups[1].options).toEqual([
      opt("magpie/opencode-go/vendor/model:1", "Model"),
    ])
  })

  it("unwraps Hermes' named Magpie endpoint without splitting model colons", () => {
    const groups = deriveModelGroups(
      modelOption([
        opt("custom:magpie:auto/fast", "auto/Fast"),
        opt("custom:magpie:relay/vendor/model:tag", "relay/Model:tag", "64k"),
      ])
    )!
    expect(groups?.map((group) => group.name)).toEqual(["auto", "relay"])
    expect(groups[1].options).toEqual([
      opt("custom:magpie:relay/vendor/model:tag", "Model:tag", "64k"),
    ])
  })

  it("keeps DSH's three protocols distinct for the same upstream", () => {
    const groups = deriveModelGroups(
      modelOption([
        opt('["magpie","auto/model"]', "Chat", "chat-completions"),
        opt('["magpie-responses","auto/model"]', "Responses", "responses"),
        opt('["magpie-anthropic","auto/model"]', "Anthropic", "messages"),
      ])
    )!
    expect(groups?.map((group) => group.name)).toEqual([
      "auto · Magpie",
      "auto · Magpie · Responses",
      "auto · Magpie · Anthropic",
    ])
    expect(new Set(groups.map((group) => group.key)).size).toBe(3)
    expect(groups.flatMap((group) => group.options)).toEqual([
      opt('["magpie","auto/model"]', "Chat", "chat-completions"),
      opt('["magpie-responses","auto/model"]', "Responses", "responses"),
      opt('["magpie-anthropic","auto/model"]', "Anthropic", "messages"),
    ])
  })

  it("preserves the exact spelling of escaped DSH JSON and nested model ids", () => {
    const value = '[ "magpie-responses", "new-source/vendor/model:\\\"v1\\\"" ]'
    const groups = deriveModelGroups(
      modelOption([opt(value, "Quoted model", "User label")])
    )!
    expect(groups?.map((group) => group.name)).toEqual([
      "new-source · Magpie · Responses",
    ])
    expect(groups[0].options).toEqual([
      opt(
        '[ "magpie-responses", "new-source/vendor/model:\\\"v1\\\"" ]',
        "Quoted model",
        "User label"
      ),
    ])
  })

  it("leaves unknown and malformed JSON selectors ungrouped", () => {
    const option = modelOption([
      opt('["other","auto/model"]'),
      opt('["magpie","auto/model","extra"]'),
      opt('["magpie",42]'),
      opt('["magpie","plain"]'),
      opt('["magpie","auto/model"'),
      opt('{"provider":"magpie","model":"auto/model"}'),
    ])
    expect(deriveModelGroups(option)).toBeNull()
    expect(modelListGroups(option)[0].options).toBe(option.kind.options)
  })

  it("surfaces a single Magpie source even with already clean names", () => {
    const groups = deriveModelGroups(
      modelOption([opt("magpie/auto/fast", "Fast")])
    )!
    expect(groups?.map((group) => group.name)).toEqual(["auto"])
    expect(groups[0].options).toEqual([opt("magpie/auto/fast", "Fast")])
  })

  it("removes only one known Magpie wrapper", () => {
    const groups = deriveModelGroups(
      modelOption([opt("magpie/magpie/openai/model", "Model")])
    )!
    expect(groups?.map((group) => group.name)).toEqual(["magpie"])
    expect(groups[0].options[0].value).toBe("magpie/magpie/openai/model")
  })

  it("refines DSH route buckets without changing unrelated native groups", () => {
    const option = modelOption([])
    const untouched = {
      group: "curated",
      name: "My models",
      options: [opt("anthropic/opus", "Opus"), opt("openai/gpt", "GPT")],
    }
    option.kind.groups = [
      {
        group: "magpie",
        name: "Magpie",
        options: [
          opt('["magpie","auto/fast"]', "Fast"),
          opt('["magpie","relay/model"]', "Model"),
          opt('["magpie","auto/smart"]', "Smart"),
        ],
      },
      untouched,
      {
        group: "magpie-responses",
        name: "Magpie · Responses",
        options: [opt('["magpie-responses","auto/fast"]', "Fast")],
      },
    ]
    const groups = modelListGroups(option)
    expect(groups.map((group) => group.name)).toEqual([
      "auto · Magpie",
      "relay · Magpie",
      "My models",
      "auto · Magpie · Responses",
    ])
    expect(groups[0].options.map((item) => item.value)).toEqual([
      '["magpie","auto/fast"]',
      '["magpie","auto/smart"]',
    ])
    expect(groups[2]).toEqual({
      key: "curated",
      name: "My models",
      options: untouched.options,
    })
    expect(new Set(groups.map((group) => group.key)).size).toBe(4)
  })

  it("refines legacy Hermes and OpenCode Magpie buckets", () => {
    const option = modelOption([])
    option.kind.groups = [
      {
        group: "Magpie",
        name: "Magpie",
        options: [
          opt("custom:magpie:auto/fast", "auto/Fast"),
          opt("custom:magpie:relay/model", "relay/Model"),
        ],
      },
      {
        group: "magpie",
        name: "Magpie via Headroom",
        options: [opt("magpie/auto/fast", "Fast")],
      },
    ]
    const groups = modelListGroups(option)
    expect(groups.map((group) => group.name)).toEqual(["auto", "relay", "auto"])
    expect(new Set(groups.map((group) => group.key)).size).toBe(3)
  })

  it("respects meaningful native groups even when their values are wrapped", () => {
    const option = modelOption([])
    option.kind.groups = [
      {
        group: "automatic",
        name: "Automatic routing",
        options: [opt("custom:magpie:auto/fast", "Fast")],
      },
      {
        group: "favorites",
        name: "Favorites",
        options: [opt("magpie/openai/model", "My preferred model")],
      },
    ]
    expect(deriveModelGroups(option)).toBeNull()
    expect(modelListGroups(option).map((group) => group.name)).toEqual([
      "Automatic routing",
      "Favorites",
    ])
  })

  it("returns null for non-model options", () => {
    const mode = modelOption([opt("anthropic/opus")], {
      id: "mode",
      category: "mode",
    })
    expect(deriveModelGroups(mode)).toBeNull()
  })

  it("returns null when no value carries a slash (stays flat)", () => {
    const option = modelOption([
      opt("default", "Default"),
      opt("opus", "Opus"),
      opt("haiku", "Haiku"),
    ])
    expect(deriveModelGroups(option)).toBeNull()
  })

  it("respects server-provided groups verbatim (returns null)", () => {
    const option = modelOption([opt("anthropic/opus")])
    option.kind.groups = [
      {
        group: "anthropic",
        name: "Anthropic",
        options: [opt("anthropic/opus", "Opus")],
      },
    ]
    expect(deriveModelGroups(option)).toBeNull()
  })

  it("groups by the first slash and preserves first-seen order", () => {
    const option = modelOption([
      opt("anthropic/claude-opus"),
      opt("openai/gpt-4o"),
      opt("anthropic/claude-sonnet"),
      opt("google/gemini-2.0"),
    ])
    const groups = deriveModelGroups(option)
    expect(groups?.map((g) => g.name)).toEqual([
      "anthropic",
      "openai",
      "google",
    ])
    const anthropic = groups?.find((g) => g.name === "anthropic")
    // Labels strip the redundant `anthropic/` prefix (name repeated the value).
    expect(anthropic?.options.map((o) => o.name)).toEqual([
      "claude-opus",
      "claude-sonnet",
    ])
    // Values are never rewritten — only the display label is stripped.
    expect(anthropic?.options.map((o) => o.value)).toEqual([
      "anthropic/claude-opus",
      "anthropic/claude-sonnet",
    ])
  })

  it("uses the shared display-name prefix as header and strips it from rows", () => {
    // Real OpenCode shape: values are `opencode/…` (its id prefix), but every
    // display name repeats a human `OpenCode Zen/…`. The shared NAME prefix wins
    // for the header and is stripped from each row so it isn't shown twice.
    const option = modelOption([
      opt("opencode/big-pickle", "OpenCode Zen/Big Pickle"),
      opt("opencode/claude-haiku", "OpenCode Zen/Claude Haiku"),
      opt("anthropic/claude-opus", "anthropic/claude-opus"),
    ])
    const groups = deriveModelGroups(option)
    const zen = groups?.find((g) => g.key === "opencode")
    expect(zen?.name).toBe("OpenCode Zen")
    expect(zen?.options.map((o) => o.name)).toEqual([
      "Big Pickle",
      "Claude Haiku",
    ])
    // Values stay the full id — only the label changed.
    expect(zen?.options.map((o) => o.value)).toEqual([
      "opencode/big-pickle",
      "opencode/claude-haiku",
    ])
  })

  it("falls back to the value-id prefix as header when names don't share one", () => {
    const option = modelOption([
      opt("anthropic/claude-opus", "Claude Opus"),
      opt("anthropic/claude-sonnet", "Claude Sonnet"),
      opt("openai/gpt-4o", "GPT-4o"),
    ])
    const groups = deriveModelGroups(option)
    const anthropic = groups?.find((g) => g.key === "anthropic")
    // Clean names have no "/" → nothing redundant → header is the id prefix and
    // labels are left untouched.
    expect(anthropic?.name).toBe("anthropic")
    expect(anthropic?.options.map((o) => o.name)).toEqual([
      "Claude Opus",
      "Claude Sonnet",
    ])
  })

  it("floats prefix-less values into a leading headerless bucket", () => {
    const option = modelOption([
      opt("default", "Default"),
      opt("anthropic/opus", "anthropic/opus"),
      opt("openai/gpt", "openai/gpt"),
    ])
    const groups = deriveModelGroups(option) as ModelOptionGroup[]
    expect(groups[0]).toMatchObject({ name: null })
    expect(groups[0].options.map((o) => o.name)).toEqual(["Default"])
    expect(groups.slice(1).map((g) => g.name)).toEqual(["anthropic", "openai"])
  })

  it("groups a lone provider, stripping the prefix repeated on every row", () => {
    const option = modelOption([opt("anthropic/opus"), opt("anthropic/sonnet")])
    const groups = deriveModelGroups(option)
    expect(groups?.map((g) => g.name)).toEqual(["anthropic"])
    expect(groups?.[0].options.map((o) => o.name)).toEqual(["opus", "sonnet"])
  })

  it("strips the shared prefix for a single-provider OpenCode list (R2)", () => {
    // Only one value prefix, nothing floating — must still drop the repeated
    // `OpenCode Zen/` shown on every row (regression for the real OpenCode shape
    // when the list contains only that provider).
    const option = modelOption([
      opt("opencode/big-pickle", "OpenCode Zen/Big Pickle"),
      opt("opencode/claude-haiku", "OpenCode Zen/Claude Haiku"),
    ])
    const groups = deriveModelGroups(option)
    expect(groups?.map((g) => g.name)).toEqual(["OpenCode Zen"])
    expect(groups?.[0].options.map((o) => o.name)).toEqual([
      "Big Pickle",
      "Claude Haiku",
    ])
    expect(groups?.[0].options.map((o) => o.value)).toEqual([
      "opencode/big-pickle",
      "opencode/claude-haiku",
    ])
  })

  it("keeps a lone provider flat when its names carry no repeated prefix", () => {
    // value has a `provider/` prefix but the display names are already clean →
    // nothing redundant to strip, so no lone header is forced.
    const option = modelOption([
      opt("anthropic/opus", "Opus"),
      opt("anthropic/sonnet", "Sonnet"),
    ])
    expect(deriveModelGroups(option)).toBeNull()
  })

  it("does not mistake a lone slashed display name for a provider prefix", () => {
    // The `meta` group has a single row whose display-name slash is NOT the
    // provider (head `Big` ≠ value prefix `meta`) → leave the label intact.
    const option = modelOption([
      opt("anthropic/claude-opus", "anthropic/claude-opus"),
      opt("meta/llama", "Big/Thing"),
    ])
    const groups = deriveModelGroups(option)
    const meta = groups?.find((g) => g.key === "meta")
    expect(meta?.name).toBe("meta")
    expect(meta?.options.map((o) => o.name)).toEqual(["Big/Thing"])
  })

  it("groups a lone provider once a prefix-less value floats beside it", () => {
    const option = modelOption([
      opt("default", "Default"),
      opt("anthropic/opus"),
    ])
    const groups = deriveModelGroups(option)
    expect(groups?.map((g) => g.name)).toEqual([null, "anthropic"])
  })

  it("groups multi-segment values under their first segment", () => {
    const option = modelOption([
      opt("openrouter/anthropic/claude"),
      opt("openrouter/openai/gpt"),
      opt("ollama/llama3"),
    ])
    const groups = deriveModelGroups(option)
    expect(groups?.map((g) => g.name)).toEqual(["openrouter", "ollama"])
    const router = groups?.find((g) => g.name === "openrouter")
    // Only the first `openrouter/` token is stripped; the sub-path remains.
    expect(router?.options.map((o) => o.name)).toEqual([
      "anthropic/claude",
      "openai/gpt",
    ])
  })

  it("does not strip a human label that does not repeat the prefix", () => {
    const option = modelOption([
      opt("anthropic/claude-opus", "Claude Opus"),
      opt("openai/gpt-4o", "GPT-4o"),
    ])
    const groups = deriveModelGroups(option)
    expect(groups?.flatMap((g) => g.options.map((o) => o.name))).toEqual([
      "Claude Opus",
      "GPT-4o",
    ])
  })

  it("treats leading/trailing slashes as ungroupable (floating)", () => {
    const option = modelOption([
      opt("/leading", "/leading"),
      opt("trailing/", "trailing/"),
      opt("anthropic/opus", "anthropic/opus"),
    ])
    const groups = deriveModelGroups(option) as ModelOptionGroup[]
    // `/leading` and `trailing/` have no usable prefix → headerless bucket.
    expect(groups[0]).toMatchObject({ name: null })
    expect(groups[0].options.map((o) => o.value)).toEqual([
      "/leading",
      "trailing/",
    ])
    expect(groups.slice(1).map((g) => g.name)).toEqual(["anthropic"])
  })
})

const SAMPLE_GROUPS: ModelOptionGroup[] = [
  { key: "__ungrouped__", name: null, options: [opt("default", "Default")] },
  {
    key: "anthropic",
    name: "anthropic",
    options: [opt("anthropic/opus", "opus"), opt("anthropic/sonnet", "sonnet")],
  },
  {
    key: "openai",
    name: "openai",
    options: [opt("openai/gpt-4o", "gpt-4o")],
  },
]

describe("modelListGroups", () => {
  it("uses the derived provider groups when applicable", () => {
    const option = modelOption([
      opt("anthropic/opus", "anthropic/opus"),
      opt("openai/gpt-4o", "openai/gpt-4o"),
    ])
    expect(modelListGroups(option).map((g) => g.name)).toEqual([
      "anthropic",
      "openai",
    ])
  })

  it("preserves server-provided groups (does NOT flatten them)", () => {
    // The agent shipped its own grouping → derive returns null; the picker must
    // keep those groups, not collapse to one headerless bucket.
    const option = modelOption([])
    option.kind.groups = [
      {
        group: "fast",
        name: "Fast",
        options: [opt("a", "A"), opt("b", "B")],
      },
      { group: "smart", name: "Smart", options: [opt("c", "C")] },
    ]
    const groups = modelListGroups(option)
    expect(groups.map((g) => g.name)).toEqual(["Fast", "Smart"])
    expect(groups.flatMap((g) => g.options.map((o) => o.value))).toEqual([
      "a",
      "b",
      "c",
    ])
  })

  it("falls back to a single headerless group for a flat list", () => {
    const option = modelOption([opt("a", "A"), opt("b", "B"), opt("c", "C")])
    const groups = modelListGroups(option)
    expect(groups).toHaveLength(1)
    expect(groups[0].name).toBeNull()
    expect(groups[0].options.map((o) => o.value)).toEqual(["a", "b", "c"])
  })
})

describe("filterModelGroups", () => {
  it("returns the groups unchanged for an empty query", () => {
    expect(filterModelGroups(SAMPLE_GROUPS, "   ")).toBe(SAMPLE_GROUPS)
  })

  it("matches on the display name (case-insensitive) and drops empty groups", () => {
    const result = filterModelGroups(SAMPLE_GROUPS, "OPUS")
    // Only "opus" (anthropic) matches; floating + openai groups drop out, and
    // the sibling "sonnet" is filtered out of the anthropic group.
    expect(result.map((g) => g.key)).toEqual(["anthropic"])
    expect(result[0].options.map((o) => o.value)).toEqual(["anthropic/opus"])
  })

  it("matches on the value id even when the label was stripped", () => {
    // The label is "gpt-4o" but the value is "openai/gpt-4o" — querying the
    // provider still finds it.
    const result = filterModelGroups(SAMPLE_GROUPS, "openai")
    expect(result.map((g) => g.key)).toEqual(["openai"])
  })

  it("returns an empty list when nothing matches", () => {
    expect(filterModelGroups(SAMPLE_GROUPS, "zzz")).toEqual([])
  })
})

describe("flattenModelGroups", () => {
  it("emits a header row per named group and one row per option", () => {
    const rows = flattenModelGroups(SAMPLE_GROUPS)
    expect(
      rows.map((r) => (r.kind === "header" ? `#${r.name}` : r.option.value))
    ).toEqual([
      // The floating bucket (name === null) contributes NO header row.
      "default",
      "#anthropic",
      "anthropic/opus",
      "anthropic/sonnet",
      "#openai",
      "openai/gpt-4o",
    ])
  })

  it("namespaces option keys by group so duplicate values never collide", () => {
    const rows = flattenModelGroups([
      { key: "a", name: "a", options: [opt("x/m", "m")] },
      { key: "b", name: "b", options: [opt("x/m", "m")] },
    ])
    const optionKeys = rows.filter((r) => r.kind === "option").map((r) => r.key)
    expect(new Set(optionKeys).size).toBe(optionKeys.length)
  })
})
