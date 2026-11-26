/**
 * The Codex config.toml keys the panel no longer writes, the line scanners'
 * handling of multi-line strings, and the guard that keeps the WebSocket
 * switch to providers config.toml can configure.
 *
 * Every claim below about codex itself was checked against codex 0.160.1 —
 * the build codeg's pinned codex-acp 2.2.2 runs — both in source and live:
 * - `disable_response_storage` was removed in 0.30.0 (openai/codex#3212);
 *   requests are always sent with `store: false`, and 0.160.1 reports the
 *   key as "unrecognized" on every launch.
 * - `[features].responses_websockets_v2` is `Stage::Removed` since 0.116.0;
 *   only the provider's `supports_websockets` decides the transport.
 */
import { parse as parseTomlDocument } from "smol-toml"
import { describe, expect, it } from "vitest"

import {
  codexWebsocketSwitchApplies,
  extractCodexImportantValues,
  patchCodexConfigTomlText,
  patchCodexSuppressUnstableFeaturesWarning,
  tomlLinesInsideMultilineString,
} from "./acp-agent-settings"

describe("disable_response_storage is no longer forced", () => {
  it("is not added by any structured control", () => {
    for (const patch of [
      {},
      { model: "gpt-5.5" },
      { apiBaseUrl: "https://api.example/v1" },
      { modelProvider: "codeg" },
      { supportsWebsockets: true },
      { supportsWebsockets: false },
      { defaultModeRequestUserInput: true },
    ]) {
      expect(patchCodexConfigTomlText("", patch)).not.toContain(
        "disable_response_storage"
      )
    }
  })

  // It used to be overwritten with `= true` on every patch, so a user could
  // not even set it the other way.
  it("leaves a hand-written value exactly as written", () => {
    const toml = 'model = "gpt-5.5"\ndisable_response_storage = false\n'
    const out = patchCodexConfigTomlText(toml, { model: "gpt-6-astra" })
    expect(out).toContain("disable_response_storage = false")
    expect(out).not.toContain("disable_response_storage = true")
  })
})

describe("tomlLinesInsideMultilineString", () => {
  function inside(text: string): boolean[] {
    return tomlLinesInsideMultilineString(text.split("\n"))
  }

  it("marks the lines after an opening delimiter up to the closing one", () => {
    expect(inside('a = """\nx\ny"""\nb = 1')).toEqual([
      false,
      true,
      true,
      false,
    ])
    expect(inside("a = '''\n[x]\n'''\n[y]")).toEqual([false, true, true, false])
  })

  it("does not open on a single-line, quoted or commented delimiter", () => {
    expect(inside('a = """one line"""\n[x]')).toEqual([false, false])
    expect(inside(`a = '"""'\n[x]`)).toEqual([false, false])
    expect(inside('a = "\\"\\"\\""\n[x]')).toEqual([false, false])
    expect(inside('a = 1 # """\n[x]')).toEqual([false, false])
  })

  it("honours escapes and quotes just inside the closing delimiter", () => {
    // `\"""` is an escaped quote plus two quotes, not a delimiter; `""""`
    // closes the string with one quote of content.
    expect(inside('a = """\n\\"""\n""""\n[x]')).toEqual([
      false,
      true,
      true,
      false,
    ])
    expect(inside("a = '''\nb'''''\n[x]")).toEqual([false, true, false])
  })
})

// Review finding: a header- or key-shaped line inside a multi-line string is
// neither, so the scanners must reach the real structure and leave the
// string, closing delimiter included, alone.
describe("config.toml scanners skip multi-line string content", () => {
  it("reads the root key, not a look-alike in a later string", () => {
    const toml = [
      'model = "gpt-5.5"',
      'developer_instructions = """',
      'model = "not-a-key"',
      '"""',
      "",
    ].join("\n")
    expect(extractCodexImportantValues("", toml).model).toBe("gpt-5.5")
  })

  // Read as structure, the pseudo-header would also end the root table early.
  it("rewrites the root key, not a look-alike in an earlier string", () => {
    const toml = [
      'developer_instructions = """',
      "[profiles.example]",
      'model = "not-a-key"',
      '"""',
      'model = "gpt-5.5"',
      "",
    ].join("\n")
    expect(
      parseTomlDocument(
        patchCodexConfigTomlText(toml, { model: "gpt-6-astra" })
      )
    ).toEqual({
      developer_instructions: '[profiles.example]\nmodel = "not-a-key"\n',
      model: "gpt-6-astra",
    })
  })

  const TOML = [
    'model_provider = "relay"',
    'developer_instructions = """',
    "[model_providers.relay] # example",
    'supports_websockets = true"""',
    "",
    "[model_providers.relay]",
    'name = "relay"',
    'wire_api = "responses"',
    'base_url = "https://relay.example/v1"',
    "supports_websockets = true",
    "",
  ].join("\n")
  const INSTRUCTIONS =
    "[model_providers.relay] # example\nsupports_websockets = true"

  type Doc = {
    developer_instructions?: string
    model_providers?: Record<string, Record<string, unknown>>
  }

  it("switches the real table off", () => {
    const off = parseTomlDocument(
      patchCodexConfigTomlText(TOML, { supportsWebsockets: false })
    ) as Doc
    expect(off.model_providers?.relay?.supports_websockets).toBeUndefined()
    expect(off.model_providers?.relay?.name).toBe("relay")
    expect(off.developer_instructions).toBe(INSTRUCTIONS)
  })

  it("moves the real base_url", () => {
    const moved = parseTomlDocument(
      patchCodexConfigTomlText(TOML, {
        apiBaseUrl: "https://moved.example/v1",
      })
    ) as Doc
    expect(moved.model_providers?.relay?.base_url).toBe(
      "https://moved.example/v1"
    )
    expect(moved.developer_instructions).toBe(INSTRUCTIONS)
  })
})

// A `[profiles.<name>]` may set its own model and provider, for that profile
// only. Reading them as the root values made every patch copy them over the
// root keys.
describe("model and model_provider are read from the root table", () => {
  const TOML = [
    'model = "gpt-5.5"',
    'model_provider = "relay"',
    "",
    "[model_providers.relay]",
    'base_url = "https://relay.example/v1"',
    "",
    "[profiles.fast]",
    'model = "gpt-5.5-mini"',
    'model_provider = "other"',
    "",
  ].join("\n")

  it("ignores a profile's values", () => {
    const values = extractCodexImportantValues("", TOML)
    expect(values.model).toBe("gpt-5.5")
    expect(values.modelProvider).toBe("relay")
    expect(values.apiBaseUrl).toBe("https://relay.example/v1")
  })

  it("reads back the model the writer wrote", () => {
    const next = patchCodexConfigTomlText(TOML, { model: "gpt-6-astra" })
    expect(extractCodexImportantValues("", next).model).toBe("gpt-6-astra")
    expect(parseTomlDocument(next)).toMatchObject({
      model: "gpt-6-astra",
      profiles: { fast: { model: "gpt-5.5-mini" } },
    })
  })

  // What the WebSocket switch does: it passes the provider it reads.
  it("keeps the root keys through the WebSocket switch", () => {
    const { modelProvider } = extractCodexImportantValues("", TOML)
    const doc = parseTomlDocument(
      patchCodexConfigTomlText(TOML, {
        modelProvider,
        supportsWebsockets: true,
      })
    ) as {
      model?: string
      model_provider?: string
      model_providers?: Record<string, Record<string, unknown>>
    }
    expect(doc.model).toBe("gpt-5.5")
    expect(doc.model_provider).toBe("relay")
    expect(Object.keys(doc.model_providers ?? {})).toEqual(["relay"])
    expect(doc.model_providers?.relay?.supports_websockets).toBe(true)
  })
})

describe("codexWebsocketSwitchApplies", () => {
  it("is off for Official Subscription and on for the provider modes", () => {
    expect(codexWebsocketSwitchApplies("chatgpt_subscription", "codeg")).toBe(
      false
    )
    expect(codexWebsocketSwitchApplies("api_key", "codeg")).toBe(true)
    expect(codexWebsocketSwitchApplies("model_provider", "codeg")).toBe(true)
    expect(codexWebsocketSwitchApplies("api_key", "my-relay")).toBe(true)
  })

  // codex keeps its built-in entry whatever `[model_providers.<id>]` says, and
  // the Bedrock ids and `gcp` reject the whole config over a
  // `supports_websockets`.
  it("is off when the active provider is one of codex's built-ins", () => {
    for (const id of [
      "openai",
      "amazon-bedrock",
      "amazon-bedrock-runtime",
      "gcp",
      "ollama",
      "lmstudio",
    ]) {
      expect(codexWebsocketSwitchApplies("api_key", id)).toBe(false)
    }
  })
})

// Root `suppress_unstable_features_warning` — the key codex's own
// "Under-development features enabled" warning tells the user to set. It is a
// top-level `ConfigToml` field (codex-cli 0.170.0), so it must land in the
// ROOT table: written below a `[section]` header it would become that
// section's key and silence nothing.
describe("codex suppress_unstable_features_warning toggle", () => {
  const KEY = "suppress_unstable_features_warning"

  function readsBackAs(configTomlText: string): boolean {
    return extractCodexImportantValues("", configTomlText)
      .suppressUnstableFeaturesWarning
  }

  function rootValue(configTomlText: string): unknown {
    return (parseTomlDocument(configTomlText) as Record<string, unknown>)[KEY]
  }

  it("is off for a config that never mentions it", () => {
    expect(readsBackAs("")).toBe(false)
    expect(readsBackAs('model = "gpt-5"')).toBe(false)
  })

  it("is not injected by any other control", () => {
    for (const patch of [
      {},
      { model: "gpt-5.5" },
      { apiBaseUrl: "https://api.example/v1" },
      { supportsWebsockets: true },
      { defaultModeRequestUserInput: true },
    ]) {
      expect(patchCodexConfigTomlText("", patch)).not.toContain(KEY)
    }
  })

  it("writes a root key and reads it straight back", () => {
    const on = patchCodexSuppressUnstableFeaturesWarning("", true)
    expect(rootValue(on)).toBe(true)
    expect(readsBackAs(on)).toBe(true)
  })

  it("stays in the root table when the file has sections", () => {
    const toml = [
      'model = "gpt-5"',
      "",
      "[features]",
      "default_mode_request_user_input = true",
      "",
      "[model_providers.codeg]",
      'base_url = "https://api.example/v1"',
    ].join("\n")
    const on = patchCodexSuppressUnstableFeaturesWarning(toml, true)
    const doc = parseTomlDocument(on) as {
      features: Record<string, unknown>
      model_providers: { codeg: Record<string, unknown> }
    }
    expect(doc[KEY as keyof typeof doc]).toBe(true)
    expect(doc.features).toEqual({ default_mode_request_user_input: true })
    expect(doc.model_providers.codeg).not.toHaveProperty(KEY)
    expect(readsBackAs(on)).toBe(true)
  })

  it("stays in the root table when the file opens with a section", () => {
    const toml = "[features]\ndefault_mode_request_user_input = true\n"
    const on = patchCodexSuppressUnstableFeaturesWarning(toml, true)
    expect(rootValue(on)).toBe(true)
    expect(
      (parseTomlDocument(on) as { features: Record<string, unknown> }).features
    ).toEqual({ default_mode_request_user_input: true })
    // On then off is a no-op: no separator line is left behind.
    expect(patchCodexSuppressUnstableFeaturesWarning(on, false)).toBe(toml)
  })

  it("does not duplicate the key when switched on twice", () => {
    const once = patchCodexSuppressUnstableFeaturesWarning(
      'model = "gpt-5"\n',
      true
    )
    const twice = patchCodexSuppressUnstableFeaturesWarning(once, true)
    expect(twice).toBe(once)
    expect(() => parseTomlDocument(twice)).not.toThrow()
  })

  it("flips a hand-written false instead of adding a second line", () => {
    const on = patchCodexSuppressUnstableFeaturesWarning(
      `${KEY} = false\nmodel = "gpt-5"\n`,
      true
    )
    expect(on.match(new RegExp(KEY, "g"))).toHaveLength(1)
    expect(rootValue(on)).toBe(true)
  })

  it("removes the key when switched off and leaves the rest alone", () => {
    const toml = `model = "gpt-5"\n${KEY} = true\n\n[features]\ndefault_mode_request_user_input = true\n`
    const off = patchCodexSuppressUnstableFeaturesWarning(toml, false)
    expect(off).not.toContain(KEY)
    expect(off).toContain("default_mode_request_user_input = true")
    expect(readsBackAs(off)).toBe(false)
  })

  // `"x" = true` and `'x' = true` are the same TOML key as `x = true`. Missing
  // them showed the switch off, and switching it on appended a bare duplicate
  // that made the whole save fail to parse.
  it("treats a quoted spelling as the same key", () => {
    for (const spelling of [`"${KEY}"`, `'${KEY}'`]) {
      const toml = `model = "gpt-5"\n${spelling} = true\n`
      expect(readsBackAs(toml)).toBe(true)
      const on = patchCodexSuppressUnstableFeaturesWarning(
        toml.replace("= true", "= false"),
        true
      )
      expect(() => parseTomlDocument(on)).not.toThrow()
      expect(rootValue(on)).toBe(true)
      const off = patchCodexSuppressUnstableFeaturesWarning(toml, false)
      expect(off).not.toContain(KEY)
    }
  })

  // A quoted key containing a dot is ONE key, not the dotted path.
  it("does not read a quoted dotted key as a dotted path", () => {
    const toml = `"features.default_mode_request_user_input" = true\n`
    expect(
      extractCodexImportantValues("", toml).defaultModeRequestUserInput
    ).toBe(false)
  })

  it("reads a value with a comment hard against it", () => {
    expect(readsBackAs(`${KEY} = true# quiet\n`)).toBe(true)
    const off = patchCodexSuppressUnstableFeaturesWarning(
      `${KEY} = true# quiet\n`,
      false
    )
    expect(off).not.toContain(KEY)
  })

  // patchCodexConfigTomlText re-serializes `model` on every call; this switch
  // must not go through it and touch a line the user did not ask to change.
  it("leaves every other line byte-for-byte as written", () => {
    const toml = [
      '  model = "\\U00000067pt-5"  # escaped on purpose  ',
      "",
      "[features]",
      "default_mode_request_user_input = true",
      "",
    ].join("\n")
    const on = patchCodexSuppressUnstableFeaturesWarning(toml, true)
    expect(on.split("\n").filter((line) => !line.includes(KEY))).toEqual(
      toml.split("\n")
    )
    expect(rootValue(on)).toBe(true)
    expect(patchCodexSuppressUnstableFeaturesWarning(on, false)).toBe(toml)
  })

  it("keeps CRLF line endings", () => {
    const toml = 'model = "gpt-5"\r\n\r\n[features]\r\nx = true\r\n'
    const on = patchCodexSuppressUnstableFeaturesWarning(toml, true)
    expect(on.replace(/\r\n/g, "")).not.toContain("\n")
    expect(rootValue(on)).toBe(true)
    expect(patchCodexSuppressUnstableFeaturesWarning(on, false)).toBe(toml)
  })

  it("reads a comment holding a Unicode line separator", () => {
    const toml = `${KEY} = true # a\u2028b\n`
    expect(readsBackAs(toml)).toBe(true)
    expect(
      patchCodexSuppressUnstableFeaturesWarning(toml, false)
    ).not.toContain(KEY)
  })

  // Under `[profiles.x]` the key applies to that profile only, and inside any
  // other table it is not the root key at all; the writer never edits either,
  // so reading them would show a value no save could clear.
  it("ignores the same key outside the root table", () => {
    expect(readsBackAs(`[profiles.fast]\n${KEY} = true\n`)).toBe(false)
    expect(readsBackAs(`[features]\n${KEY} = true\n`)).toBe(false)
  })
})
