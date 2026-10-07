import { describe, expect, it } from "vitest"

import { referenceToMarkdown } from "@/components/chat/composer/reference-text"
import type { ReferenceAttrs } from "@/components/chat/composer/types"

import { parseUserMessageSegments } from "./user-message-segments"

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

/** The single reference segment in `text`, or fail. */
function onlyReference(text: string): ReferenceAttrs {
  const segments = parseUserMessageSegments(text)
  const refs = segments.filter((s) => s.kind === "reference")
  expect(refs).toHaveLength(1)
  return (refs[0] as { kind: "reference"; attrs: ReferenceAttrs }).attrs
}

describe("parseUserMessageSegments", () => {
  it("keeps plain prose as a single literal text segment", () => {
    expect(parseUserMessageSegments("hello world")).toEqual([
      { kind: "text", text: "hello world" },
    ])
  })

  it("renders Markdown syntax VERBATIM (no formatting)", () => {
    // The whole point of the feature: nothing here is a reference, so it is one
    // literal text run — headings/bold/lists/code are not interpreted.
    const md = "# Heading\n**bold** and _em_\n- item\n```\ncode\n```"
    expect(parseUserMessageSegments(md)).toEqual([{ kind: "text", text: md }])
  })

  it("preserves newlines as literal text (renderer handles pre-wrap)", () => {
    expect(parseUserMessageSegments("a\nb\n\nc")).toEqual([
      { kind: "text", text: "a\nb\n\nc" },
    ])
  })

  describe("reference links → badges", () => {
    it("parses a file link", () => {
      const attrs = onlyReference("see [app.ts](file:///repo/app.ts) now")
      expect(attrs.refType).toBe("file")
      expect(attrs.uri).toBe("file:///repo/app.ts")
      expect(attrs.label).toBe("app.ts")
    })

    it("parses an agent link and strips the leading @", () => {
      const attrs = onlyReference("[@Codex](codeg://agent/codex)")
      expect(attrs.refType).toBe("agent")
      expect(attrs.label).toBe("Codex")
      expect(attrs.meta?.agentType).toBe("codex")
    })

    it("parses a session link", () => {
      const attrs = onlyReference("re [My chat](codeg://session/42)")
      expect(attrs.refType).toBe("session")
      expect(attrs.uri).toBe("codeg://session/42")
    })

    it("parses a commit link", () => {
      const attrs = onlyReference(
        "[a1b2c3d](codeg://commit/%2Frepo@a1b2c3ddeadbeef)"
      )
      expect(attrs.refType).toBe("commit")
      expect(attrs.id).toBe("a1b2c3ddeadbeef")
      expect(attrs.meta?.shortHash).toBe("a1b2c3d")
    })

    it("unwraps an angle-bracket destination (spaces in the path)", () => {
      const attrs = onlyReference("[f](<file:///a/b (1).ts>)")
      expect(attrs.refType).toBe("file")
      expect(attrs.uri).toBe("file:///a/b (1).ts")
    })

    it("unescapes the label of an escaped reference", () => {
      // referenceToMarkdown backslash-escapes `_` in labels (`a_b.ts` → `a\_b.ts`).
      const attrs = onlyReference("[a\\_b.ts](file:///a_b.ts)")
      expect(attrs.label).toBe("a_b.ts")
    })

    it("leaves a NON-reference link literal (not a badge)", () => {
      const segments = parseUserMessageSegments("[docs](https://example.com)")
      expect(segments).toEqual([
        { kind: "text", text: "[docs](https://example.com)" },
      ])
    })
  })

  describe("bare invocation tokens → skill badges", () => {
    it("badges a /command token, dropping its prefix from the label", () => {
      const segments = parseUserMessageSegments("run /review please")
      expect(segments[0]).toEqual({ kind: "text", text: "run " })
      const skill = segments[1] as { kind: "reference"; attrs: ReferenceAttrs }
      expect(skill.attrs.refType).toBe("skill")
      // Badge label matches the composer's inline badge: the bare name, no `/`.
      expect(skill.attrs.label).toBe("review")
      expect(segments[2]).toEqual({ kind: "text", text: " please" })
    })

    it("badges a $skill token, dropping its prefix from the label", () => {
      const attrs = onlyReference("$deploy now")
      expect(attrs.refType).toBe("skill")
      expect(attrs.label).toBe("deploy")
    })

    it("does NOT badge a file-ish path", () => {
      expect(parseUserMessageSegments("see /usr/bin for it")).toEqual([
        { kind: "text", text: "see /usr/bin for it" },
      ])
    })

    it("does NOT badge a token that isn't at a word boundary", () => {
      expect(parseUserMessageSegments("a/b/c")).toEqual([
        { kind: "text", text: "a/b/c" },
      ])
    })

    describe("restricted to an agent's advertised invocations", () => {
      const knownInvocations = new Set(["/review"])

      it("badges only a token on the list", () => {
        expect(
          parseUserMessageSegments("run /review please", { knownInvocations })
        ).toHaveLength(3)
        expect(
          parseUserMessageSegments("run /notacommand please", {
            knownInvocations,
          })
        ).toEqual([{ kind: "text", text: "run /notacommand please" }])
      })

      it("keeps unbadged tokens inside one contiguous text run", () => {
        // Two skipped tokens must not split the prose into three segments the
        // renderer would then have to stitch back together.
        expect(
          parseUserMessageSegments("/a and /b", { knownInvocations })
        ).toEqual([{ kind: "text", text: "/a and /b" }])
      })

      it("still badges the reference links around an unknown token", () => {
        expect(
          parseUserMessageSegments("/nope [a.ts](file:///a.ts)", {
            knownInvocations,
          })
        ).toEqual([
          { kind: "text", text: "/nope " },
          { kind: "reference", attrs: expect.objectContaining({ id: "a.ts" }) },
        ])
      })
    })
  })

  // Guardrail: the render tokenizer must invert referenceToMarkdown (the wire
  // format) for every kind — serialize an attrs, parse it back, recover the kind.
  describe("round-trips referenceToMarkdown", () => {
    const cases: Array<[string, ReferenceAttrs]> = [
      [
        "file",
        ref({
          refType: "file",
          id: "app.ts",
          label: "app.ts",
          uri: "file:///repo/app.ts",
          meta: { fileKind: "file" },
        }),
      ],
      [
        "file with special chars",
        ref({
          refType: "file",
          id: "a_(1).ts",
          label: "a_(1).ts",
          uri: "file:///repo/a_(1).ts",
          meta: { fileKind: "file" },
        }),
      ],
      [
        // A uri holding `\`, `<` or `>` is angle-wrapped AND backslash-escaped
        // by escapeLinkDestination; parsing has to decode those escapes or the
        // recovered uri carries doubled backslashes (wrong path, and one more
        // doubling per round-trip).
        "windows file with backslashes",
        ref({
          refType: "file",
          // The basename split is `/`-only, so a backslash-only path yields the
          // whole path as id (unchanged by the escape decode; `buildFileUri`
          // never emits this form, but an agent-supplied ResourceLink can).
          id: "C:\\repo\\app.ts",
          label: "app.ts",
          uri: "file:///C:\\repo\\app.ts",
          meta: { fileKind: "file" },
        }),
      ],
      [
        "file with angle brackets",
        ref({
          refType: "file",
          id: "a<b>c.ts",
          label: "a<b>c.ts",
          uri: "file:///repo/a<b>c.ts",
          meta: { fileKind: "file" },
        }),
      ],
      [
        "agent",
        ref({
          refType: "agent",
          id: "codex",
          label: "Codex",
          uri: "codeg://agent/codex",
          meta: { agentType: "codex" },
        }),
      ],
      [
        "session",
        ref({
          refType: "session",
          id: "42",
          label: "My chat",
          uri: "codeg://session/42",
        }),
      ],
      [
        "commit",
        ref({
          refType: "commit",
          id: "a1b2c3ddeadbeef",
          label: "a1b2c3d",
          uri: "codeg://commit/%2Frepo@a1b2c3ddeadbeef",
          meta: { shortHash: "a1b2c3d" },
        }),
      ],
      [
        "skill",
        ref({
          refType: "skill",
          id: "code-review",
          label: "Code review",
          uri: null,
          meta: { invocationPrefix: "/" },
        }),
      ],
      [
        "codex skill",
        ref({
          refType: "skill",
          id: "deploy",
          label: "Deploy",
          uri: null,
          meta: { invocationPrefix: "$" },
        }),
      ],
    ]

    it.each(cases)("recovers a %s reference", (_name, attrs) => {
      const recovered = onlyReference(referenceToMarkdown(attrs))
      expect(recovered.refType).toBe(attrs.refType)
      expect(recovered.id).toBe(attrs.id)
      if (attrs.uri) expect(recovered.uri).toBe(attrs.uri)
    })
  })
})
