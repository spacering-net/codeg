import { describe, expect, it } from "vitest"

import { JsoncEditError, parseJsoncObject, patchJsoncText } from "./jsonc-edit"

const DOC = `{
  // the default model
  "model": "anthropic/claude-x", // keep this note
  "providers": {
    /* my relay */
    "relay": {
      "package": "aisdk:@ai-sdk/openai-compatible",
      "settings": { "baseURL": "https://relay.example/v1" },
    },
  },
}
`

describe("parseJsoncObject", () => {
  it("reads comments and trailing commas like OpenCode", () => {
    const parsed = parseJsoncObject(DOC)
    expect(parsed.error).toBeNull()
    expect(parsed.value?.model).toBe("anthropic/claude-x")
  })

  it("treats empty text as an empty object and rejects non-objects", () => {
    expect(parseJsoncObject("  \n")).toEqual({ value: {}, error: null })
    expect(parseJsoncObject("[1]").value).toBeNull()
    expect(parseJsoncObject('{ "a": ').error).not.toBeNull()
  })

  it("ignores a byte-order mark", () => {
    expect(parseJsoncObject('﻿{"a": 1}').value).toEqual({ a: 1 })
  })
})

describe("patchJsoncText", () => {
  it("changes only the edited values and keeps every comment", () => {
    const out = patchJsoncText(DOC, (draft) => {
      draft.model = "relay/gpt-x"
      const providers = draft.providers as Record<
        string,
        Record<string, unknown>
      >
      providers.relay.name = "Relay"
    })
    expect(out).toContain("// the default model")
    expect(out).toContain("// keep this note")
    expect(out).toContain("/* my relay */")
    expect(parseJsoncObject(out).value).toEqual({
      model: "relay/gpt-x",
      providers: {
        relay: {
          package: "aisdk:@ai-sdk/openai-compatible",
          settings: { baseURL: "https://relay.example/v1" },
          name: "Relay",
        },
      },
    })
  })

  it("removes keys deleted from the draft, whole subtrees included", () => {
    const out = patchJsoncText(DOC, (draft) => {
      delete draft.providers
    })
    expect(parseJsoncObject(out).value).toEqual({ model: "anthropic/claude-x" })
    // A comment trailing the separator before a removed property goes with it
    // (jsonc-parser's removal range, the same as OpenCode's own writers);
    // the rest of the document stays.
    expect(out).toContain("// the default model")
  })

  it("leaves text untouched when nothing changed", () => {
    expect(patchJsoncText(DOC, () => {})).toBe(DOC)
  })

  it("replaces arrays whole and starts empty documents fresh", () => {
    const withList = patchJsoncText("", (draft) => {
      draft.plugins = ["a@1.0.0"]
    })
    expect(parseJsoncObject(withList).value).toEqual({ plugins: ["a@1.0.0"] })
    const changed = patchJsoncText(withList, (draft) => {
      draft.plugins = ["a@1.0.0", "b@2.0.0"]
    })
    expect(parseJsoncObject(changed).value).toEqual({
      plugins: ["a@1.0.0", "b@2.0.0"],
    })
  })

  it("refuses a document it cannot read instead of replacing it", () => {
    expect(() => patchJsoncText('{ "model": ', () => {})).toThrow(
      JsoncEditError
    )
    expect(() => patchJsoncText("[]", () => {})).toThrow(JsoncEditError)
  })

  it("follows the document's indentation for inserted values", () => {
    const tabbed = '{\n\t"a": 1\n}\n'
    const out = patchJsoncText(tabbed, (draft) => {
      draft.b = { c: true }
    })
    expect(out).toContain('\n\t"b": {\n\t\t"c": true\n\t}')
  })
})
