import { describe, expect, it } from "vitest"

import { referenceToMarkdown } from "./reference-text"
import type { ReferenceAttrs } from "./types"

function ref(partial: Partial<ReferenceAttrs>): ReferenceAttrs {
  return {
    refType: "file",
    id: "",
    label: "",
    uri: null,
    meta: null,
    ...partial,
  }
}

describe("referenceToMarkdown", () => {
  it("renders a file as a markdown link to its file:// uri", () => {
    expect(
      referenceToMarkdown(
        ref({ refType: "file", label: "app.ts", uri: "file:///repo/app.ts" })
      )
    ).toBe("[app.ts](file:///repo/app.ts)")
  })

  it("renders a session as a markdown link to its codeg:// uri", () => {
    expect(
      referenceToMarkdown(
        ref({ refType: "session", label: "Login", uri: "codeg://session/123" })
      )
    ).toBe("[Login](codeg://session/123)")
  })

  it("renders a commit as a markdown link", () => {
    expect(
      referenceToMarkdown(
        ref({
          refType: "commit",
          label: "abc1234",
          uri: "codeg://commit/repo@abc1234def",
        })
      )
    ).toBe("[abc1234](codeg://commit/repo@abc1234def)")
  })

  it("renders an agent as @label (no uri)", () => {
    expect(
      referenceToMarkdown(
        ref({ refType: "agent", id: "claude_code", label: "Claude Code" })
      )
    ).toBe("@Claude Code")
  })

  it("renders an agent with a uri as a [@label](codeg://agent/…) link", () => {
    expect(
      referenceToMarkdown(
        ref({
          refType: "agent",
          id: "codex",
          label: "Codex",
          uri: "codeg://agent/codex",
        })
      )
    ).toBe("[@Codex](codeg://agent/codex)")
  })

  it("renders an assistant as a [@name](codeg://assistant/<id>) link", () => {
    expect(
      referenceToMarkdown(
        ref({
          refType: "assistant",
          id: "3",
          label: "Code Reviewer",
          uri: "codeg://assistant/3",
          meta: { assistantId: 3 },
        })
      )
    ).toBe("[@Code Reviewer](codeg://assistant/3)")
  })

  it("escapes an assistant name that could break out of its link", () => {
    // The backend's routing scan accepts backslash escapes inside the text.
    expect(
      referenceToMarkdown(
        ref({
          refType: "assistant",
          id: "3",
          label: "Rev](x) [y",
          uri: "codeg://assistant/3",
        })
      )
    ).toBe("[@Rev\\]\\(x\\) \\[y](codeg://assistant/3)")
  })

  it("renders a skill as a /invocation token from its id", () => {
    expect(
      referenceToMarkdown(ref({ refType: "skill", id: "code-review" }))
    ).toBe("/code-review")
  })

  it("uses the stable skill id for invocation, not the display label", () => {
    expect(
      referenceToMarkdown(
        ref({ refType: "skill", id: "code-review", label: "Code Review" })
      )
    ).toBe("/code-review")
  })

  it("neutralizes a skill with no id (no broken /command)", () => {
    expect(
      referenceToMarkdown(
        ref({ refType: "skill", id: "", label: "Code Review" })
      )
    ).toBe("")
  })

  it("uses the `$` prefix for a Codex skill (meta.invocationPrefix)", () => {
    expect(
      referenceToMarkdown(
        ref({
          refType: "skill",
          id: "deploy",
          label: "Deploy",
          meta: { invocationPrefix: "$" },
        })
      )
    ).toBe("$deploy")
  })

  it("uses the `$` prefix for a Codex expert", () => {
    expect(
      referenceToMarkdown(
        ref({
          refType: "skill",
          id: "reviewer",
          label: "Reviewer",
          meta: { scope: "expert", invocationPrefix: "$" },
        })
      )
    ).toBe("$reviewer")
  })

  it("defaults to `/` when invocationPrefix is absent", () => {
    expect(
      referenceToMarkdown(
        ref({ refType: "skill", id: "build", meta: { scope: "expert" } })
      )
    ).toBe("/build")
  })

  describe("markdown injection is neutralized", () => {
    it("escapes brackets and parens in link text so a label cannot break out", () => {
      expect(
        referenceToMarkdown(
          ref({
            refType: "session",
            label: "a](http://evil) x",
            uri: "codeg://session/1",
          })
        )
      ).toBe("[a\\]\\(http://evil\\) x](codeg://session/1)")
    })

    it("escapes backticks in link text", () => {
      expect(
        referenceToMarkdown(
          ref({ refType: "session", label: "a`b", uri: "codeg://session/2" })
        )
      ).toBe("[a\\`b](codeg://session/2)")
    })

    it("angle-wraps a destination containing spaces or parentheses", () => {
      expect(
        referenceToMarkdown(
          ref({ refType: "file", label: "f", uri: "file:///a/b (1).ts" })
        )
      ).toBe("[f](<file:///a/b (1).ts>)")
    })

    it("escapes backslashes inside an angle-wrapped destination", () => {
      // A literal "\>" must not become escaped-backslash + closing ">", which
      // would end the destination early and allow a second link to be injected.
      // "\" -> "\\" and ">" -> "\>"  ⇒  "\\\>".
      expect(
        referenceToMarkdown(
          ref({ refType: "file", label: "f", uri: "file:///a/\\> x" })
        )
      ).toBe("[f](<file:///a/\\\\\\> x>)")
    })

    it("collapses newlines in a label to a single space", () => {
      expect(
        referenceToMarkdown(ref({ refType: "agent", label: "line1\nline2" }))
      ).toBe("@line1 line2")
    })

    it("escapes brackets in an agent label", () => {
      expect(referenceToMarkdown(ref({ refType: "agent", label: "a]b" }))).toBe(
        "@a\\]b"
      )
    })

    it("escapes link-breaking chars in a uri-bearing agent label", () => {
      expect(
        referenceToMarkdown(
          ref({
            refType: "agent",
            label: "a](http://evil) x",
            uri: "codeg://agent/codex",
          })
        )
      ).toBe("[@a\\]\\(http://evil\\) x](codeg://agent/codex)")
    })

    it("code-spans a URL-like agent label so it cannot autolink", () => {
      expect(
        referenceToMarkdown(ref({ refType: "agent", label: "http://evil" }))
      ).toBe("@`http://evil`")
    })

    it("code-spans a URL-like no-uri fallback label", () => {
      expect(
        referenceToMarkdown(
          ref({ refType: "file", label: "www.evil.com", uri: null })
        )
      ).toBe("`www.evil.com`")
    })

    it("code-spans a skill id that would inject Markdown (autolink trigger)", () => {
      // Skill ids come from filesystem names; a malicious one must not inject a
      // second link / image into the prompt or the transcript bubble.
      expect(
        referenceToMarkdown(ref({ refType: "skill", id: "![x](http://evil)" }))
      ).toBe("`/![x](http://evil)`")
    })

    it("escapes structural chars in a skill id with no autolink trigger", () => {
      expect(
        referenceToMarkdown(ref({ refType: "skill", id: "foo[bar]" }))
      ).toBe("/foo\\[bar\\]")
    })

    it("keeps a normal underscore/dot/slash skill id literal (must invoke)", () => {
      // Underscores are common in agent/skill ids (e.g. claude_code) and MUST
      // NOT be escaped, or the agent receives a non-invocable `/claude\_code`.
      expect(
        referenceToMarkdown(ref({ refType: "skill", id: "claude_code" }))
      ).toBe("/claude_code")
      expect(
        referenceToMarkdown(ref({ refType: "skill", id: "scope/my.skill_v2" }))
      ).toBe("/scope/my.skill_v2")
    })

    it("keeps a namespaced command id literal (must invoke)", () => {
      // Qoder advertises skills as `sites:sites-building`; an escaped `_` in a
      // namespaced name would reach the agent as a different command.
      expect(
        referenceToMarkdown(
          ref({ refType: "skill", id: "sites:sites-building" })
        )
      ).toBe("/sites:sites-building")
      expect(
        referenceToMarkdown(ref({ refType: "skill", id: "my_plugin:run_all" }))
      ).toBe("/my_plugin:run_all")
    })

    it("still neutralizes a namespaced id that could autolink or emphasize", () => {
      expect(
        referenceToMarkdown(ref({ refType: "skill", id: "http:evil" }))
      ).toBe("`/http:evil`")
      expect(referenceToMarkdown(ref({ refType: "skill", id: "a:_b" }))).toBe(
        "/a:\\_b"
      )
    })

    it("escapes a `_` that flanks a separator (would emphasize otherwise)", () => {
      // `/a/_b_/c` parses as `/a/<em>b</em>/c` in CommonMark — a non-intraword
      // `_` must be escaped so no emphasis leaks into the prompt/transcript.
      expect(
        referenceToMarkdown(ref({ refType: "skill", id: "a/_b_/c" }))
      ).toBe("/a/\\_b\\_/c")
    })
  })

  it("falls back to the bare label when a uri type has no uri", () => {
    expect(
      referenceToMarkdown(ref({ refType: "file", label: "app.ts", uri: null }))
    ).toBe("app.ts")
  })

  it("falls back to id when label is empty", () => {
    expect(
      referenceToMarkdown(ref({ refType: "agent", id: "codex", label: "" }))
    ).toBe("@codex")
  })
})
