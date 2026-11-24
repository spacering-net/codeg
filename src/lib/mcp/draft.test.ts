import { describe, expect, it } from "vitest"

import {
  definitionFromDraft,
  definitionToJson,
  draftFromDefinition,
  draftProblems,
  emptyDraft,
  isLoopbackHost,
  parseDefinitionJson,
  remoteUrlHint,
  sameDefinition,
} from "./draft"

describe("the form", () => {
  it("is the definition, both ways", () => {
    const definition = {
      type: "stdio" as const,
      command: "npx",
      args: ["-y", "server", ""],
      env: { TOKEN: "t", MODE: "x" },
    }
    expect(definitionFromDraft(draftFromDefinition(definition))).toEqual(
      definition
    )
  })

  it("keeps the other transport's fields while it is not the one chosen", () => {
    const draft = draftFromDefinition({
      type: "http",
      url: "https://a.test/mcp",
      headers: { Authorization: "Bearer x" },
    })
    const local = { ...draft, transport: "stdio" as const, command: "npx" }
    expect(definitionFromDraft(local)).toEqual({
      type: "stdio",
      command: "npx",
    })
    expect(definitionFromDraft({ ...local, transport: "http" })).toEqual({
      type: "http",
      url: "https://a.test/mcp",
      headers: { Authorization: "Bearer x" },
    })
  })

  it("names what stops a save, and ignores a row left wholly blank", () => {
    const draft = {
      ...emptyDraft(),
      args: [
        { id: 1, value: "-y" },
        { id: 2, value: "" },
      ],
      env: [
        { id: 3, name: "", value: "" },
        { id: 4, name: "", value: "orphan" },
        { id: 5, name: "A", value: "1" },
        { id: 6, name: " A ", value: "2" },
      ],
    }
    expect(draftProblems(draft)).toEqual([
      { kind: "commandRequired" },
      { kind: "argEmpty", index: 1 },
      { kind: "nameRequired", list: "env", index: 1 },
      { kind: "nameRepeated", list: "env", name: "A" },
    ])
  })

  it("compares definitions as the engine does: env in any order, args in order", () => {
    expect(
      sameDefinition(
        { type: "stdio", command: "x", env: { A: "1", B: "2" } },
        { type: "stdio", command: "x", env: { B: "2", A: "1" } }
      )
    ).toBe(true)
    expect(
      sameDefinition(
        { type: "stdio", command: "x", args: ["a", "b"] },
        { type: "stdio", command: "x", args: ["b", "a"] }
      )
    ).toBe(false)
  })
})

describe("the JSON view", () => {
  it("shows what a save writes, and reads it back", () => {
    const text = definitionToJson({ type: "stdio", command: "npx" })
    // What a save writes: no empty `args` or `env`, which the agent's file
    // will not have either.
    expect(JSON.parse(text)).toEqual({ type: "stdio", command: "npx" })
    expect(parseDefinitionJson(text)).toEqual({
      definition: { type: "stdio", command: "npx" },
    })
    const remote = definitionToJson({
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: {},
    })
    expect(JSON.parse(remote)).toEqual({
      type: "http",
      url: "https://mcp.example.com/mcp",
    })
    const full = definitionToJson({
      type: "sse",
      url: "https://mcp.example.com/sse",
      headers: { "X-Team": "a" },
    })
    expect(JSON.parse(full).headers).toEqual({ "X-Team": "a" })
  })

  it("never hands the engine an empty list, from the form or from the JSON", () => {
    expect(
      definitionFromDraft({
        ...emptyDraft("http"),
        url: "https://mcp.example.com/mcp",
        headers: [{ id: 1, name: "", value: "" }],
      })
    ).toEqual({ type: "http", url: "https://mcp.example.com/mcp" })
    expect(
      parseDefinitionJson(
        '{"type":"http","url":"https://mcp.example.com/mcp","headers":{}}'
      )
    ).toEqual({
      definition: { type: "http", url: "https://mcp.example.com/mcp" },
    })
  })

  it("reads a missing type as the engine does", () => {
    expect(parseDefinitionJson('{"command": "uvx", "args": ["x"]}')).toEqual({
      definition: { type: "stdio", command: "uvx", args: ["x"] },
    })
    expect(parseDefinitionJson('{"url": "https://a.test"}')).toEqual({
      definition: { type: "http", url: "https://a.test" },
    })
  })

  it.each([
    ["{ broken", "syntax"],
    ["[]", "notObject"],
    ['{"type": "websocket", "url": "x"}', "type"],
    ['{"args": []}', "noTransport"],
    ['{"type": "stdio", "command": "x", "args": [1]}', "fieldType"],
    ['{"type": "stdio", "command": "x", "env": {"A": 1}}', "fieldType"],
    ['{"type": "stdio", "command": "x", "timeout": 30}', "unknownField"],
    ['{"type": "stdio", "command": "x", "url": "y"}', "wrongTransportField"],
  ])("says why %s is not a definition, without dropping it", (text, kind) => {
    const read = parseDefinitionJson(text)
    expect("problem" in read && read.problem.kind).toBe(kind)
  })
})

describe("addresses typed by hand", () => {
  it.each([
    ["https://mcp.example.com/mcp", null],
    ["http://localhost:3000/mcp", null],
    ["http://127.0.0.1:8080/sse", null],
    ["http://[::1]:8080/sse", null],
    ["http://dev.localhost/mcp", null],
    ["http://mcp.example.com/mcp", "insecure"],
    ["ws://mcp.example.com", "insecure"],
    ["not a url", "unreadable"],
    ["", null],
  ])("%s → %s", (url, hint) => {
    expect(remoteUrlHint(url)).toBe(hint)
  })

  it("knows the loopback names", () => {
    expect(isLoopbackHost("LOCALHOST")).toBe(true)
    expect(isLoopbackHost("127.10.0.1")).toBe(true)
    expect(isLoopbackHost("10.0.0.5")).toBe(false)
  })
})
