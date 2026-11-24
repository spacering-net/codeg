import { describe, expect, it } from "vitest"

import { parseJsoncObject } from "./jsonc-edit"
import {
  OPENCODE_PERMISSION_KEYS,
  applyOpenCodeAutoAccept,
  clearOpenCodePermissions,
  effectiveOpenCodeDefault,
  isOpenCodeConfigEditable,
  normalizeOpenCodePermissionOrder,
  readOpenCodePermissions,
  setOpenCodeGlobalPermission,
  setOpenCodeKeyPermission,
  setOpenCodeKeyRules,
} from "./opencode-permissions"

const parse = (text: string) =>
  parseJsoncObject(text).value as Record<string, unknown>
const doc = (value: unknown) => JSON.stringify(value)
const rule = (action: string, resource: string, effect: string) => ({
  action,
  resource,
  effect,
})

describe("readOpenCodePermissions", () => {
  it("reports an unset document with every known action blank", () => {
    const view = readOpenCodePermissions("")
    expect(view.shape).toBe("unset")
    expect(view.globalAction).toBeNull()
    expect(view.entries.map((e) => e.key)).toEqual(
      OPENCODE_PERMISSION_KEYS.map((m) => m.key)
    )
    expect(view.entries.every((e) => e.action === null)).toBe(true)
  })

  it("reads a grouped rule list into the editor's model", () => {
    const view = readOpenCodePermissions(
      doc({
        permissions: [
          rule("*", "*", "ask"),
          rule("shell", "*", "ask"),
          rule("shell", "git status *", "allow"),
          rule("shell", "git push *", "deny"),
          rule("github_create_issue", "*", "deny"),
        ],
      })
    )
    expect(view.shape).toBe("rules")
    expect(view.legacy).toBe(false)
    expect(view.globalAction).toBe("ask")
    expect(view.orderingUnsafe).toBe(false)
    const shell = view.entries.find((e) => e.key === "shell")
    expect(shell).toEqual({
      key: "shell",
      action: "ask",
      rules: [
        { pattern: "git status *", action: "allow" },
        { pattern: "git push *", action: "deny" },
      ],
      custom: false,
    })
    // MCP tools and plugin actions come after the known ones.
    expect(view.entries[view.entries.length - 1]).toEqual({
      key: "github_create_issue",
      action: "deny",
      rules: [],
      custom: true,
    })
  })

  it("keeps `*` rules for specific resources visible", () => {
    const view = readOpenCodePermissions(
      doc({
        permissions: [rule("*", "*", "allow"), rule("*", "*.secret", "deny")],
      })
    )
    expect(view.globalAction).toBe("allow")
    expect(view.entries[view.entries.length - 1]).toEqual({
      key: "*",
      action: null,
      rules: [{ pattern: "*.secret", action: "deny" }],
      custom: true,
    })
    expect(view.autoAcceptAll).toBe(false)
  })

  it("reads 1.x's permission and tools the way OpenCode 2 converts them", () => {
    const view = readOpenCodePermissions(
      doc({
        tools: { webfetch: false },
        permission: {
          "*": "ask",
          bash: { "*": "ask", "git *": "allow" },
          task: "deny",
          write: "ask",
        },
      })
    )
    expect(view.legacy).toBe(true)
    expect(view.globalAction).toBe("ask")
    expect(view.entries.find((e) => e.key === "shell")).toMatchObject({
      action: "ask",
      rules: [{ pattern: "git *", action: "allow" }],
    })
    expect(view.entries.find((e) => e.key === "subagent")?.action).toBe("deny")
    expect(view.entries.find((e) => e.key === "edit")?.action).toBe("ask")
    expect(view.entries.find((e) => e.key === "webfetch")?.action).toBe("deny")
    // The tools rule comes first and the `*` rule after it: written order is
    // not the editor's, so it says so.
    expect(view.orderingUnsafe).toBe(true)
    expect(view.orderingFixable).toBe(true)
  })

  it("reads a bare 1.x action as the global default", () => {
    const view = readOpenCodePermissions('{"permission": "allow"}')
    expect(view.globalAction).toBe("allow")
    expect(view.autoAcceptAll).toBe(true)
  })

  it("flags a malformed list instead of guessing", () => {
    for (const permissions of [
      "allow",
      [{ action: "shell", resource: "*" }],
      [{ action: "shell", resource: "*", effect: "maybe" }],
    ]) {
      expect(readOpenCodePermissions(doc({ permissions })).invalid).toBe(true)
    }
    expect(
      readOpenCodePermissions(doc({ permission: { bash: 3 } })).invalid
    ).toBe(true)
  })

  it("treats unparsable text as unset rather than throwing", () => {
    expect(readOpenCodePermissions("{ nope").shape).toBe("unset")
    expect(isOpenCodeConfigEditable("{ nope")).toBe(false)
    expect(isOpenCodeConfigEditable("")).toBe(true)
    expect(isOpenCodeConfigEditable('{\n// c\n"a": 1,\n}')).toBe(true)
  })

  it("only calls it auto-accept when nothing can still prompt", () => {
    expect(
      readOpenCodePermissions(doc({ permissions: [rule("*", "*", "allow")] }))
        .autoAcceptAll
    ).toBe(true)
    expect(
      readOpenCodePermissions(
        doc({
          permissions: [rule("*", "*", "allow"), rule("shell", "rm *", "deny")],
        })
      ).autoAcceptAll
    ).toBe(false)
    expect(
      readOpenCodePermissions(
        doc({
          permissions: [rule("*", "*", "allow")],
          agents: { reviewer: { permissions: [rule("edit", "*", "deny")] } },
        })
      ).autoAcceptAll
    ).toBe(false)
  })
})

describe("writers", () => {
  it("write the global default first, in OpenCode 2's shape", () => {
    const out = setOpenCodeGlobalPermission(
      doc({ model: "a/b", permissions: [rule("shell", "*", "deny")] }),
      "ask"
    )
    expect(parse(out)).toEqual({
      model: "a/b",
      permissions: [rule("*", "*", "ask"), rule("shell", "*", "deny")],
    })
    // Clearing the only rule removes the key.
    expect(
      parse(
        setOpenCodeGlobalPermission(
          doc({ permissions: [rule("*", "*", "ask")] }),
          null
        )
      )
    ).toEqual({})
  })

  it("set a base effect, keeping the action's resource rules", () => {
    const start = doc({
      permissions: [rule("shell", "*", "ask"), rule("shell", "git *", "allow")],
    })
    expect(parse(setOpenCodeKeyPermission(start, "shell", "deny"))).toEqual({
      permissions: [
        rule("shell", "*", "deny"),
        rule("shell", "git *", "allow"),
      ],
    })
    expect(parse(setOpenCodeKeyPermission(start, "shell", null))).toEqual({
      permissions: [rule("shell", "git *", "allow")],
    })
    expect(setOpenCodeKeyPermission(start, "*", "allow")).toBe(start)
  })

  it("replace an action's resource rules, deduplicating like OpenCode", () => {
    const out = setOpenCodeKeyRules(
      doc({ permissions: [rule("edit", "*", "ask")] }),
      "edit",
      [
        { pattern: "src/*", action: "allow" },
        { pattern: " ", action: "deny" },
        { pattern: "*", action: "deny" },
        { pattern: "docs/*", action: "deny" },
        { pattern: "src/*", action: "deny" },
      ]
    )
    expect(parse(out)).toEqual({
      permissions: [
        rule("edit", "*", "ask"),
        rule("edit", "docs/*", "deny"),
        rule("edit", "src/*", "deny"),
      ],
    })
  })

  it("convert 1.x keys on the first edit and keep comments", () => {
    const text = `{
  // my settings
  "model": "a/b",
  "permission": { "bash": "ask", "task": "deny" },
  "tools": { "webfetch": false },
}
`
    const out = setOpenCodeKeyPermission(text, "edit", "ask")
    expect(out).toContain("// my settings")
    expect(parse(out)).toEqual({
      model: "a/b",
      permissions: [
        rule("webfetch", "*", "deny"),
        rule("shell", "*", "ask"),
        rule("subagent", "*", "deny"),
        rule("edit", "*", "ask"),
      ],
    })
  })

  it("leave unparsable or malformed documents alone", () => {
    expect(setOpenCodeGlobalPermission("{ nope", "allow")).toBe("{ nope")
    const malformed = doc({ permissions: "allow" })
    expect(setOpenCodeKeyPermission(malformed, "shell", "deny")).toBe(malformed)
  })
})

describe("applyOpenCodeAutoAccept", () => {
  it("replaces every narrowing rule with one allow-all", () => {
    const out = applyOpenCodeAutoAccept(
      doc({
        permissions: [rule("shell", "rm *", "deny")],
        permission: { bash: "ask" },
        tools: { edit: false },
        policies: [
          { action: "tool.use", resource: "shell:sudo *", effect: "deny" },
        ],
      })
    )
    expect(parse(out)).toEqual({
      permissions: [rule("*", "*", "allow")],
      // Policies are not permissions; a hard deny stays.
      policies: [
        { action: "tool.use", resource: "shell:sudo *", effect: "deny" },
      ],
    })
    expect(readOpenCodePermissions(out).autoAcceptAll).toBe(true)
  })

  it("clears agents' own rules but keeps the agents", () => {
    const out = applyOpenCodeAutoAccept(
      doc({
        agents: {
          reviewer: {
            mode: "subagent",
            permissions: [rule("edit", "*", "deny")],
          },
          only: { permissions: [rule("*", "*", "ask")] },
        },
        agent: {
          old: {
            permission: { bash: "deny" },
            tools: { edit: false },
            prompt: "x",
          },
        },
        mode: { plan2: { permission: "ask" } },
      })
    )
    expect(parse(out)).toEqual({
      agents: { reviewer: { mode: "subagent" }, only: {} },
      agent: { old: { prompt: "x" } },
      mode: { plan2: {} },
      permissions: [rule("*", "*", "allow")],
    })
  })
})

describe("agent overrides", () => {
  it("are reported only when they can still prompt or block", () => {
    const view = readOpenCodePermissions(
      doc({
        agents: {
          reviewer: { permissions: [rule("edit", "*", "deny")] },
          friendly: { permissions: [rule("*", "*", "allow")] },
        },
        agent: {
          legacy: { tools: { bash: false } },
          fine: { tools: { bash: true } },
        },
        mode: { strict: { permission: { edit: "ask" } } },
      })
    )
    expect(view.agentOverrides.sort()).toEqual(["legacy", "reviewer", "strict"])
  })
})

describe("ordering", () => {
  // `rm *` allow then `*` ask asks before `rm` too. Writing the list back
  // grouped would put the broad rule first, so `rm` would run unasked.
  it("leaves rules written in another order to the explicit repair", () => {
    const text = doc({
      permissions: [rule("shell", "rm *", "allow"), rule("shell", "*", "ask")],
    })
    expect(readOpenCodePermissions(text).orderingUnsafe).toBe(true)
    expect(setOpenCodeKeyPermission(text, "read", "deny")).toBe(text)
    expect(setOpenCodeGlobalPermission(text, "ask")).toBe(text)
    expect(
      setOpenCodeKeyRules(text, "edit", [{ pattern: "*.env", action: "deny" }])
    ).toBe(text)
    expect(parse(normalizeOpenCodePermissionOrder(text))).toEqual({
      permissions: [rule("shell", "*", "ask"), rule("shell", "rm *", "allow")],
    })
  })

  it("is flagged when the global rule follows an action's", () => {
    const view = readOpenCodePermissions(
      doc({
        permissions: [rule("shell", "*", "deny"), rule("*", "*", "allow")],
      })
    )
    expect(view.orderingUnsafe).toBe(true)
    expect(view.orderingFixable).toBe(true)
    expect(view.autoAcceptAll).toBe(false)
    expect(
      parse(
        normalizeOpenCodePermissionOrder(
          doc({
            permissions: [rule("shell", "*", "deny"), rule("*", "*", "allow")],
          })
        )
      )
    ).toEqual({
      permissions: [rule("*", "*", "allow"), rule("shell", "*", "deny")],
    })
  })

  it("is flagged when an action's base follows its resource rules", () => {
    expect(
      readOpenCodePermissions(
        doc({
          permissions: [
            rule("shell", "git *", "allow"),
            rule("shell", "*", "deny"),
          ],
        })
      ).orderingUnsafe
    ).toBe(true)
  })

  it("is flagged when an action's rules are split up", () => {
    expect(
      readOpenCodePermissions(
        doc({
          permissions: [
            rule("shell", "*", "ask"),
            rule("edit", "*", "ask"),
            rule("shell", "git *", "allow"),
          ],
        })
      ).orderingUnsafe
    ).toBe(true)
  })

  it("is clean for the order codeg writes and the docs recommend", () => {
    expect(
      readOpenCodePermissions(
        doc({
          permissions: [
            rule("*", "*", "ask"),
            rule("shell", "*", "ask"),
            rule("shell", "git status *", "allow"),
            rule("shell", "git diff *", "allow"),
            rule("shell", "git push *", "deny"),
            rule("edit", "*", "deny"),
            rule("edit", "packages/web/*.mdx", "allow"),
          ],
        })
      ).orderingUnsafe
    ).toBe(false)
  })

  // The action goes through the same wildcard matcher as the resource.
  it("catches an action glob that shadows an earlier specific action", () => {
    const view = readOpenCodePermissions(
      doc({
        permissions: [
          rule("mymcp_run", "*", "deny"),
          rule("mymcp_*", "*", "allow"),
        ],
      })
    )
    expect(view.orderingUnsafe).toBe(true)
    expect(view.orderingFixable).toBe(false)
    expect(
      readOpenCodePermissions(
        doc({
          permissions: [
            rule("mymcp_*", "*", "allow"),
            rule("mymcp_run", "*", "deny"),
          ],
        })
      ).orderingUnsafe
    ).toBe(false)
  })

  // Containment, not text matching (ported from the 1.x object form, which
  // OpenCode 2 converts to the same rule order).
  it("decides resource shadowing by language containment", () => {
    const unsafe = (rules: Record<string, string>) =>
      readOpenCodePermissions(doc({ permission: { bash: rules } }))
        .orderingUnsafe
    expect(unsafe({ "git *": "ask", "git ?": "allow" })).toBe(false)
    expect(unsafe({ "git ?": "ask", "git *": "allow" })).toBe(true)
    expect(unsafe({ " *": "deny", "?*": "allow" })).toBe(false)
    expect(unsafe({ git: "deny", "git *": "allow" })).toBe(true)
    expect(unsafe({ gitx: "deny", "git *": "allow" })).toBe(false)
    expect(unsafe({ "a*": "deny", "*?": "allow" })).toBe(true)
    expect(
      unsafe({ "docker compose up": "deny", "docker compose *": "allow" })
    ).toBe(true)
  })

  it("still decides long and hashed patterns", () => {
    const unsafe = (rules: Record<string, string>) =>
      readOpenCodePermissions(doc({ permission: { edit: rules } }))
        .orderingUnsafe
    expect(
      unsafe({
        "packages/web/src/content/docs/index.mdx": "deny",
        "packages/web/src/content/docs/*.mdx": "allow",
      })
    ).toBe(true)
    expect(
      unsafe({
        "packages/web/src/content/docs/*.mdx": "allow",
        "packages/web/src/content/docs/index.mdx": "deny",
      })
    ).toBe(false)
    expect(
      unsafe({ "dist/*/????????.js": "deny", "dist/**/????????.js": "allow" })
    ).toBe(true)
    expect(
      unsafe({ "dist/*/????????.js": "deny", "dist/**/????????.map": "allow" })
    ).toBe(false)
    expect(unsafe({ "src/file.ts": "deny", "src\\file.ts": "allow" })).toBe(
      true
    )
    expect(unsafe({ "src/*": "deny", "src/**": "allow" })).toBe(true)
  })
})

describe("clearOpenCodePermissions", () => {
  it("removes every permission source but keeps the rest", () => {
    const out = clearOpenCodePermissions(
      doc({
        model: "a/b",
        permissions: [rule("*", "*", "ask")],
        permission: "deny",
        tools: {},
      })
    )
    expect(parse(out)).toEqual({ model: "a/b" })
  })

  it("is a no-op when nothing is set", () => {
    const text = doc({ model: "a/b" })
    expect(clearOpenCodePermissions(text)).toBe(text)
  })
})

describe("effectiveOpenCodeDefault", () => {
  it("falls back to OpenCode 2's base policy, which allows", () => {
    expect(effectiveOpenCodeDefault("shell", null)).toBe("allow")
    // 1.x asked for external directories; 2.x allows them by default.
    expect(effectiveOpenCodeDefault("external_directory", null)).toBe("allow")
    expect(effectiveOpenCodeDefault("mcp_tool", null)).toBe("allow")
  })

  it("a configured global default wins", () => {
    expect(effectiveOpenCodeDefault("shell", "deny")).toBe("deny")
  })
})
