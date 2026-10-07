import { describe, expect, it } from "vitest"

import {
  buildFileUri,
  buildFileUriWithRange,
  foldReferenceLinks,
  formatFileRangeLabel,
  tokenizeReferenceLinks,
  unescapeReferenceLabel,
  unwrapReferenceDestination,
} from "./reference-link"

describe("buildFileUri", () => {
  it("builds a triple-slash uri for a posix path", () => {
    expect(buildFileUri("/repo/src/app.ts")).toBe("file:///repo/src/app.ts")
  })
  it("normalizes Windows backslashes and encodes the drive segment", () => {
    expect(buildFileUri("C:\\repo\\app.ts")).toBe("file:///C%3A/repo/app.ts")
  })
  it("percent-encodes spaces, # and ? within segments (not the separators)", () => {
    expect(buildFileUri("/a/b c#d?e.ts")).toBe("file:///a/b%20c%23d%3Fe.ts")
  })
  it("builds the canonical authority form for a UNC path", () => {
    // file://server/share/doc.md (host=server), NOT file:////server/... which
    // would parse back to an empty authority + //-pathname (a web-looking url).
    expect(buildFileUri("//server/share/doc.md")).toBe(
      "file://server/share/doc.md"
    )
    expect(buildFileUri("\\\\server\\share\\doc.md")).toBe(
      "file://server/share/doc.md"
    )
  })
  it("reduces a Windows verbatim drive path to its plain form", () => {
    // What `fs::canonicalize` returns on Windows. Without the strip this hit
    // the UNC branch and produced file://%3F/C%3A/... — a uri that decodes
    // back to "?/C:/..." and fails to open (issue #392).
    expect(buildFileUri("\\\\?\\C:\\Users\\song\\uploads\\img.png")).toBe(
      "file:///C%3A/Users/song/uploads/img.png"
    )
  })
  it("reduces a Windows verbatim UNC path to the authority form", () => {
    expect(buildFileUri("\\\\?\\UNC\\server\\share\\doc.md")).toBe(
      "file://server/share/doc.md"
    )
    expect(buildFileUri("\\\\?\\unc\\server\\share\\doc.md")).toBe(
      "file://server/share/doc.md"
    )
  })
  it("leaves a verbatim device path alone (it has no plain form)", () => {
    expect(buildFileUri("\\\\?\\Volume{7b2f1c40}\\img.png")).toBe(
      "file://%3F/Volume%7B7b2f1c40%7D/img.png"
    )
  })
})

describe("unescapeReferenceLabel", () => {
  it("drops the backslash from escaped inline punctuation", () => {
    expect(unescapeReferenceLabel("a\\]b\\(c")).toBe("a]b(c")
    expect(unescapeReferenceLabel("Screenshot \\(1\\).png")).toBe(
      "Screenshot (1).png"
    )
  })
  it("leaves unescaped text untouched", () => {
    expect(unescapeReferenceLabel("plain name.ts")).toBe("plain name.ts")
  })
})

describe("unwrapReferenceDestination", () => {
  it("returns a bare destination trimmed and untouched", () => {
    expect(unwrapReferenceDestination("file:///x/foo.ts")).toBe(
      "file:///x/foo.ts"
    )
    expect(unwrapReferenceDestination("  codeg://session/42  ")).toBe(
      "codeg://session/42"
    )
    // Not angle-wrapped: a lone backslash is part of the uri, not an escape.
    expect(unwrapReferenceDestination("file:///x\\y")).toBe("file:///x\\y")
  })

  it("unwraps an angle-bracket destination", () => {
    expect(unwrapReferenceDestination("<file:///x/a b.ts>")).toBe(
      "file:///x/a b.ts"
    )
  })

  it("decodes the escapes the serializer adds inside `<…>`", () => {
    // escapeLinkDestination escapes `\`, `<` and `>` there; leaving them in
    // would double the backslashes of a Windows path on every round-trip.
    expect(unwrapReferenceDestination("<file:///C:\\\\repo\\\\app.ts>")).toBe(
      "file:///C:\\repo\\app.ts"
    )
    expect(unwrapReferenceDestination("<file:///x/a\\<b\\>c.ts>")).toBe(
      "file:///x/a<b>c.ts"
    )
  })
})

describe("tokenizeReferenceLinks", () => {
  it("splits prose around a bare-destination link", () => {
    expect(
      tokenizeReferenceLinks("look at [foo.ts](file:///x/foo.ts) here")
    ).toEqual([
      { type: "text", value: "look at " },
      {
        type: "link",
        raw: "[foo.ts](file:///x/foo.ts)",
        label: "foo.ts",
        destination: "file:///x/foo.ts",
      },
      { type: "text", value: " here" },
    ])
  })

  it("keeps the angle brackets in a <…>-wrapped destination", () => {
    // The destination must equal the old regex group `(<[^>]*>|[^)]*)` exactly —
    // including the `<…>` — so consumers can unwrap it themselves (see
    // {@link unwrapReferenceDestination}).
    expect(tokenizeReferenceLinks("[a b.ts](<file:///x/a b.ts>)")).toEqual([
      {
        type: "link",
        raw: "[a b.ts](<file:///x/a b.ts>)",
        label: "a b.ts",
        destination: "<file:///x/a b.ts>",
      },
    ])
  })

  it("accepts an empty destination", () => {
    expect(tokenizeReferenceLinks("[a]()")).toEqual([
      { type: "link", raw: "[a]()", label: "a", destination: "" },
    ])
  })

  it("treats an empty-label [](x) as prose, not a link", () => {
    // The serializer never emits an empty label (it uses `label || id`), and the
    // historical adapter regex required ≥1 label char — so this stays prose.
    expect(tokenizeReferenceLinks("[](x)")).toEqual([
      { type: "text", value: "[](x)" },
    ])
  })

  it("closes a balanced nested-bracket label at the outer ]", () => {
    expect(tokenizeReferenceLinks("[a [b]](url)")).toEqual([
      { type: "link", raw: "[a [b]](url)", label: "a [b]", destination: "url" },
    ])
  })

  it("recovers the inner link after an unbalanced outer [", () => {
    // The stray `[a ` has no balancing `]`, but the later `[b](url)` must still
    // be found rather than swallowed by the unmatched opener.
    expect(tokenizeReferenceLinks("[a [b](url)")).toEqual([
      { type: "text", value: "[a " },
      { type: "link", raw: "[b](url)", label: "b", destination: "url" },
    ])
  })

  it("recovers a later file link after stray/unbalanced brackets in prose", () => {
    // Regression for the depth-scan giving up at EOF: the trailing file link must
    // still be extracted so the transcript chip survives stray prose brackets.
    expect(
      tokenizeReferenceLinks(
        "text [oops [still open] [foo.ts](file:///x/foo.ts)"
      )
    ).toEqual([
      { type: "text", value: "text [oops [still open] " },
      {
        type: "link",
        raw: "[foo.ts](file:///x/foo.ts)",
        label: "foo.ts",
        destination: "file:///x/foo.ts",
      },
    ])
  })

  it("does not treat ] inside a bare destination as a terminator", () => {
    expect(
      tokenizeReferenceLinks("open [a\\]b.ts](file:///x/a]b.ts) now")
    ).toEqual([
      { type: "text", value: "open " },
      {
        type: "link",
        raw: "[a\\]b.ts](file:///x/a]b.ts)",
        label: "a\\]b.ts",
        destination: "file:///x/a]b.ts",
      },
      { type: "text", value: " now" },
    ])
  })

  it("leaves a bare destination with an unescaped space as prose", () => {
    // `\` + space is not a real escape; the malformed destination is verbatim.
    expect(tokenizeReferenceLinks("[a](foo\\ bar)")).toEqual([
      { type: "text", value: "[a](foo\\ bar)" },
    ])
  })

  it("leaves an unterminated link as prose", () => {
    expect(tokenizeReferenceLinks("[oops no close](file:///x")).toEqual([
      { type: "text", value: "[oops no close](file:///x" },
    ])
  })

  it("reconstructs the exact input from its tokens", () => {
    const inputs = [
      "plain text only",
      "look at [foo.ts](file:///x/foo.ts) here",
      "compare [a](file:///a) and [b](<file:///b c>)",
      "[a [b]](u) trailing",
      "[a](foo\\ bar) [ok](file:///ok)",
    ]
    for (const input of inputs) {
      const rebuilt = tokenizeReferenceLinks(input)
        .map((t) => (t.type === "link" ? t.raw : t.value))
        .join("")
      expect(rebuilt).toBe(input)
    }
  })

  it("stays linear on adversarial unmatched-bracket input (ReDoS guard)", () => {
    // A backtracking regex would go quadratic here; the single forward scan
    // must finish effectively instantly.
    const open = "[".repeat(100_000)
    expect(tokenizeReferenceLinks(open)).toEqual([
      { type: "text", value: open },
    ])
    const partial = "[a](<".repeat(100_000)
    const rebuilt = tokenizeReferenceLinks(partial)
      .map((t) => (t.type === "link" ? t.raw : t.value))
      .join("")
    expect(rebuilt).toBe(partial)
  })
})

describe("foldReferenceLinks", () => {
  it("returns '' for nullish input", () => {
    expect(foldReferenceLinks(null)).toBe("")
    expect(foldReferenceLinks(undefined)).toBe("")
    expect(foldReferenceLinks("")).toBe("")
  })

  it("folds links to their unescaped labels and keeps surrounding prose", () => {
    expect(
      foldReferenceLinks("看看 [README.md](file:///Users/x/README.md) 这是什么")
    ).toBe("看看 README.md 这是什么")
    expect(
      foldReferenceLinks(
        "[Screenshot \\(1\\).png](<file:///x/Screenshot (1).png>)"
      )
    ).toBe("Screenshot (1).png")
  })

  it("leaves malformed fragments and non-link tokens verbatim", () => {
    expect(foldReferenceLinks("@Codex /review [oops](file:///x")).toBe(
      "@Codex /review [oops](file:///x"
    )
  })

  it("folds a ranged file badge to its label", () => {
    expect(
      foldReferenceLinks("see [app.ts:10-25](file:///repo/src/app.ts#L10-25)")
    ).toBe("see app.ts:10-25")
  })
})

// The attachment markers in a user turn are written by Rust
// (`acp::types::attachment_marker`, shared by the live broadcast and every
// history parser) and parsed back here. The two escapers live in different
// languages, so pin the boundary: these are the exact strings the backend
// emits — see `attachment_markers_escape_their_label_and_destination` in
// src-tauri/src/acp/types.rs, which asserts the same values from the other
// side.
describe("backend attachment markers", () => {
  const cases: Array<[string, string, string]> = [
    // [emitted by Rust, recovered label, recovered uri]
    ["[b \\(1\\).ts](<file:///a/b (1).ts>)", "b (1).ts", "file:///a/b (1).ts"],
    ["[dir](<file:///C:\\\\dir\\\\>)", "dir", "file:///C:\\dir\\"],
    [
      "[\\]\\(http://evil\\) \\[pwn](file:///a/x.ts)",
      "](http://evil) [pwn",
      "file:///a/x.ts",
    ],
    [
      "[clipboard://a \\(b\\).txt](<clipboard://a (b).txt>)",
      "clipboard://a (b).txt",
      "clipboard://a (b).txt",
    ],
    // The common case is bare and unescaped, byte for byte as before.
    ["[app.ts](file:///a/app.ts)", "app.ts", "file:///a/app.ts"],
  ]

  it.each(cases)("round-trips %s", (emitted, label, uri) => {
    const tokens = tokenizeReferenceLinks(emitted)
    expect(tokens).toHaveLength(1)
    const token = tokens[0]
    if (token.type !== "link") throw new Error("expected one link token")
    expect(token.raw).toBe(emitted)
    expect(unescapeReferenceLabel(token.label)).toBe(label)
    expect(unwrapReferenceDestination(token.destination)).toBe(uri)
  })

  it("folds each marker to the readable name", () => {
    expect(cases.map(([emitted]) => foldReferenceLinks(emitted))).toEqual(
      cases.map(([, label]) => label)
    )
  })
})

describe("buildFileUriWithRange", () => {
  it("returns the plain file uri when no range is given", () => {
    expect(buildFileUriWithRange("/repo/src/app.ts")).toBe(
      "file:///repo/src/app.ts"
    )
    expect(buildFileUriWithRange("/repo/src/app.ts", null)).toBe(
      "file:///repo/src/app.ts"
    )
  })
  it("appends an #L<line> fragment for a single-line span", () => {
    expect(
      buildFileUriWithRange("/repo/src/app.ts", { start: 10, end: 10 })
    ).toBe("file:///repo/src/app.ts#L10")
  })
  it("appends an #L<start>-<end> fragment for a multi-line span", () => {
    expect(
      buildFileUriWithRange("/repo/src/app.ts", { start: 10, end: 25 })
    ).toBe("file:///repo/src/app.ts#L10-25")
  })
  it("keeps the # literal after percent-encoding the path segments", () => {
    expect(buildFileUriWithRange("/a/b c.ts", { start: 3, end: 7 })).toBe(
      "file:///a/b%20c.ts#L3-7"
    )
  })
  it("round-trips through the tokenizer as a single ranged link", () => {
    expect(
      tokenizeReferenceLinks(
        `[app.ts:10-25](${buildFileUriWithRange("/repo/app.ts", {
          start: 10,
          end: 25,
        })})`
      )
    ).toEqual([
      {
        type: "link",
        raw: "[app.ts:10-25](file:///repo/app.ts#L10-25)",
        label: "app.ts:10-25",
        destination: "file:///repo/app.ts#L10-25",
      },
    ])
  })
})

describe("formatFileRangeLabel", () => {
  it("returns the bare file name with no range", () => {
    expect(formatFileRangeLabel("app.ts")).toBe("app.ts")
    expect(formatFileRangeLabel("app.ts", null)).toBe("app.ts")
  })
  it("suffixes a single line as :<line>", () => {
    expect(formatFileRangeLabel("app.ts", { start: 10, end: 10 })).toBe(
      "app.ts:10"
    )
  })
  it("suffixes a span as :<start>-<end>", () => {
    expect(formatFileRangeLabel("app.ts", { start: 10, end: 25 })).toBe(
      "app.ts:10-25"
    )
  })
})
