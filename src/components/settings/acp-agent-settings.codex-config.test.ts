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
