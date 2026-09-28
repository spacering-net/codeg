import { describe, expect, it } from "vitest"

import {
  hostRulePatternKey,
  isHostRule,
  matchHostRule,
  normalizeHostRulePattern,
  parseHostRulePattern,
  validateHostRulePattern,
  type HostRule,
} from "./host-rules"

// Mirror of the table in src-tauri/src/browser/policy.rs: the two sides must
// accept the same patterns and pick the same rule.
describe("host rule patterns", () => {
  it("accepts hostnames, wildcards, ports and IPv6 literals", () => {
    for (const ok of [
      "example.com",
      "EXAMPLE.com",
      " example.com ",
      "*.example.com",
      "*",
      "localhost:3000",
      "*.corp.example:8443",
      "[::1]:3000",
      "[::1]",
      "[0:0:0:0:0:0:0:1]",
      "127.0.0.1",
      "10.0.0.1:8080",
      "*:443",
    ]) {
      expect(validateHostRulePattern(ok), ok).toBeNull()
    }
  })

  it("trims ASCII whitespace only, like the Rust side", () => {
    // `String.prototype.trim` and Rust's `str::trim` disagree on these; a
    // pattern one side accepts and the other rejects is a silently dropped
    // rule, so neither side accepts them.
    expect(validateHostRulePattern("\u0085blocked.example")).toBe("invalid")
    expect(validateHostRulePattern("blocked.example\u00a0")).toBe("invalid")
    // Vertical tab is not in Rust's `is_ascii_whitespace` either.
    expect(validateHostRulePattern("\u000bblocked.example")).toBe("invalid")
    expect(validateHostRulePattern("\u000b")).toBe("invalid")
    expect(validateHostRulePattern("\tblocked.example \n")).toBeNull()
    expect(validateHostRulePattern("\fblocked.example\r")).toBeNull()
  })

  it("lower-cases ASCII only, like the Rust side", () => {
    // U+212A KELVIN SIGN folds to `k` under Unicode lower-casing; a pattern
    // is ASCII, so it is not a pattern on either side.
    expect(validateHostRulePattern("\u212A.example")).toBe("invalid")
    expect(normalizeHostRulePattern("\u212A.example")).toBe("\u212A.example")
  })

  it("refuses URLs, paths, bad ports and malformed hosts", () => {
    expect(validateHostRulePattern("")).toBe("empty")
    expect(validateHostRulePattern("   ")).toBe("empty")
    for (const bad of [
      "https://example.com",
      "example.com/path",
      "example.com:",
      "example.com:0",
      "example.com:70000",
      "example.com:80a",
      "*.",
      "*example.com",
      "a b.com",
      ".example.com",
      "example..com",
      "[::1",
      "[::1]x",
      "[1::2::3]",
      "[not-an-address]",
      "[*]",
      "[*.example.com]",
      "[*]:443",
      "*.*",
    ]) {
      expect(validateHostRulePattern(bad), bad).toBe("invalid")
      expect(parseHostRulePattern(bad), bad).toBeNull()
    }
  })

  it("normalizes to trimmed lower case", () => {
    expect(normalizeHostRulePattern("  Example.COM:8080 ")).toBe(
      "example.com:8080"
    )
  })

  it("recognizes stored rules and rejects junk", () => {
    expect(isHostRule({ pattern: "a.example", action: "block" })).toBe(true)
    expect(isHostRule({ pattern: "a.example", action: "explode" })).toBe(false)
    expect(isHostRule({ pattern: "", action: "block" })).toBe(false)
    expect(isHostRule("a.example")).toBe(false)
    expect(isHostRule(null)).toBe(false)
  })
})

describe("matchHostRule", () => {
  const block: HostRule[] = [{ pattern: "*.example.com", action: "block" }]

  it("wildcard semantics", () => {
    expect(
      matchHostRule(block, new URL("https://a.example.com/"))
    ).not.toBeNull()
    expect(
      matchHostRule(block, new URL("https://a.b.example.com/"))
    ).not.toBeNull()
    expect(matchHostRule(block, new URL("https://example.com/"))).toBeNull()
    expect(matchHostRule(block, new URL("https://notexample.com/"))).toBeNull()
    expect(
      matchHostRule([{ pattern: "*", action: "system" }], new URL("http://x/"))
    ).not.toBeNull()
    expect(
      matchHostRule(
        [{ pattern: "[::1]:3000", action: "builtin" }],
        new URL("http://[::1]:3000/")
      )
    ).not.toBeNull()
    expect(
      matchHostRule(
        [{ pattern: "[::1]:3000", action: "builtin" }],
        new URL("http://[::1]:3001/")
      )
    ).toBeNull()
  })

  it("ports pin a rule and compare against the scheme's default", () => {
    expect(
      matchHostRule(
        [{ pattern: "example.com:443", action: "builtin" }],
        new URL("https://EXAMPLE.com/")
      )
    ).not.toBeNull()
    expect(
      matchHostRule(
        [{ pattern: "example.com:80", action: "builtin" }],
        new URL("https://example.com/")
      )
    ).toBeNull()
    expect(
      matchHostRule(
        [{ pattern: "example.com:80", action: "builtin" }],
        new URL("http://example.com/")
      )
    ).not.toBeNull()
  })

  it("never matches an unparsable pattern", () => {
    expect(
      matchHostRule(
        [{ pattern: "https://example.com", action: "block" }],
        new URL("https://example.com/")
      )
    ).toBeNull()
    expect(matchHostRule([], new URL("https://example.com/"))).toBeNull()
    expect(matchHostRule(undefined, new URL("https://example.com/"))).toBeNull()
  })

  // Mirror of the Rust `host_spellings_that_name_the_same_server_match`.
  it("matches every spelling of the same server, and nothing without a host", () => {
    const block: HostRule[] = [{ pattern: "example.com", action: "block" }]
    expect(matchHostRule(block, new URL("http://example.com./"))).not.toBeNull()
    expect(matchHostRule(block, new URL("http://EXAMPLE.COM/"))).not.toBeNull()
    expect(
      matchHostRule(block, new URL("http://user:pw@example.com:8080/"))
    ).not.toBeNull()
    expect(
      matchHostRule(
        [{ pattern: "[0:0:0:0:0:0:0:1]:3000", action: "block" }],
        new URL("http://[::1]:3000/")
      )
    ).not.toBeNull()
    expect(
      matchHostRule(
        [{ pattern: "[::1]", action: "block" }],
        new URL("http://[0:0:0:0:0:0:0:1]/")
      )
    ).not.toBeNull()
    expect(
      matchHostRule([{ pattern: "*", action: "block" }], new URL("about:blank"))
    ).toBeNull()
  })

  it("picks the most specific rule regardless of order, first listed on a tie", () => {
    const rules: HostRule[] = [
      { pattern: "*", action: "system" },
      { pattern: "*.corp.example", action: "builtin" },
      { pattern: "*.corp.example:8443", action: "system" },
      { pattern: "sso.corp.example", action: "block" },
      { pattern: "*.sso.corp.example", action: "builtin" },
    ]
    const action = (url: string) =>
      matchHostRule(rules, new URL(url))?.action ?? null
    expect(action("https://sso.corp.example/")).toBe("block")
    expect(action("https://sso.corp.example:8443/")).toBe("block")
    expect(action("https://wiki.corp.example:8443/")).toBe("system")
    expect(action("https://wiki.corp.example/")).toBe("builtin")
    expect(action("https://a.sso.corp.example/")).toBe("builtin")
    expect(action("https://elsewhere.example/")).toBe("system")
    // Equal specificity: the more restrictive action, whatever the order —
    // including two spellings of one host.
    expect(
      matchHostRule(
        [
          { pattern: "dup.example", action: "builtin" },
          { pattern: "dup.example", action: "block" },
        ],
        new URL("https://dup.example/")
      )?.action
    ).toBe("block")
    expect(
      matchHostRule(
        [
          { pattern: "[0:0:0:0:0:0:0:1]", action: "system" },
          { pattern: "[::1]", action: "block" },
        ],
        new URL("http://[::1]/")
      )?.action
    ).toBe("block")
    // Equal in every respect: the first listed.
    const same: HostRule[] = [
      { pattern: "dup.example", action: "system" },
      { pattern: "dup.example", action: "system" },
    ]
    expect(matchHostRule(same, new URL("https://dup.example/"))).toBe(same[0])
  })

  it("keys two spellings of one rule the same", () => {
    expect(hostRulePatternKey("[0:0:0:0:0:0:0:1]:3000")).toBe(
      hostRulePatternKey(" [::1]:3000 ")
    )
    expect(hostRulePatternKey("Example.COM")).toBe(
      hostRulePatternKey("example.com")
    )
    expect(hostRulePatternKey("example.com")).not.toBe(
      hostRulePatternKey("example.com:80")
    )
    expect(hostRulePatternKey("*.example.com")).not.toBe(
      hostRulePatternKey("example.com")
    )
    expect(hostRulePatternKey("not a pattern")).toBeNull()
  })
})
