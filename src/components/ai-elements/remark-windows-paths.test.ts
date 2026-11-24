import { describe, expect, it } from "vitest"
import remarkParse from "remark-parse"
import { unified } from "unified"
import {
  remarkRestoreWindowsPaths,
  restorePathSeparators,
} from "./remark-windows-paths"

type UrlNode = { type: string; url?: string; children?: UrlNode[] }

/**
 * Every node url after the plugin has run, parsed with the same remark-parse
 * Streamdown uses. Link and image DESTINATIONS are only visible here — an
 * image never reaches the DOM, since harden replaces it with a placeholder.
 */
function urlsIn(tree: UrlNode): string[] {
  const urls: string[] = []
  const walk = (node: UrlNode) => {
    if (node.url !== undefined) urls.push(`${node.type}=${node.url}`)
    node.children?.forEach(walk)
  }
  walk(tree)
  return urls
}

function destinationsOf(source: string): string[] {
  return urlsIn(
    unified()
      .use(remarkParse)
      .use(remarkRestoreWindowsPaths)
      .runSync(unified().use(remarkParse).parse(source), source) as UrlNode
  )
}

/** The same, WITHOUT the plugin — i.e. exactly what `main` renders. */
function untouchedDestinationsOf(source: string): string[] {
  return urlsIn(unified().use(remarkParse).parse(source) as UrlNode)
}

const ASCII_PUNCTUATION = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"

/**
 * CommonMark's `characterEscape` construct — a backslash before ASCII
 * punctuation is dropped — which is how remark produces the `value` this
 * plugin is handed. Deriving the input keeps the tests honest: they assert the
 * repair against what the parser really did, not against a hand-written guess.
 */
function parse(raw: string): string {
  let out = ""
  for (let i = 0; i < raw.length; i += 1) {
    const next = raw[i + 1]
    if (
      raw[i] === "\\" &&
      next !== undefined &&
      ASCII_PUNCTUATION.includes(next)
    ) {
      out += next
      i += 1
      continue
    }
    out += raw[i]
  }
  return out
}

/** The repair, applied to the value the parser would have produced. */
function repair(raw: string): string {
  return restorePathSeparators(raw, parse(raw)) ?? parse(raw)
}

describe("restorePathSeparators — puts the separator back", () => {
  it("repairs the issue #508 path", () => {
    const path =
      "C:\\workspace\\code\\hajia\\web\\hj-cloud-single.git\\.playwright-cli\\pam-login-failed-20260818-083606-368.png"
    expect(parse(path)).toContain("hj-cloud-single.git.playwright-cli")
    expect(repair(path)).toBe(path)
  })

  it("repairs every punctuation-initial segment shape", () => {
    for (const path of [
      "C:\\a\\.playwright-cli\\shot.png",
      "C:\\a\\-dir\\_x\\(y)\\#z\\+w\\!v\\file.txt",
      "C:\\a\\.b\\.c\\.d",
      "C:\\用户\\张三\\.gitconfig",
      "C:\\a\\$Recycle.Bin\\x",
      "C:\\a\\~old~\\b",
      "C:\\repo\\_private_\\file.txt",
      "C:\\a\\[notes](draft)\\b",
      "C:\\a\\foo)\\.env",
      "C:\\a\\my[1].txt\\.env",
      ".\\scripts\\.env",
      "..\\scripts\\.env",
    ]) {
      expect(repair(path)).toBe(path)
    }
  })

  it("repairs a UNC path's interior separators (leading `\\\\` stays lossy)", () => {
    // The parser reads the leading `\\` as an escaped backslash and emits one,
    // which this cannot second-guess without breaking every path the agent
    // escaped itself. Interior separators still come back. Same as main.
    expect(repair("\\\\srv\\share\\.env")).toBe("\\srv\\share\\.env")
  })

  it("repairs a path embedded in prose, in either order", () => {
    expect(repair("截图已保存：C:\\a\\.b.png")).toBe(
      "截图已保存：C:\\a\\.b.png"
    )
    expect(repair("run C:\\a\\.b then C:\\c\\.d done")).toBe(
      "run C:\\a\\.b then C:\\c\\.d done"
    )
  })
})

describe("remarkRestoreWindowsPaths — link destinations", () => {
  it("repairs every link destination shape", () => {
    expect(destinationsOf("[a](C:\\a\\.b)")).toEqual(["link=C:\\a\\.b"])
    // An empty label has no children, so its `]` is found at offset 1.
    expect(destinationsOf("[](C:\\a\\.b)")).toEqual(["link=C:\\a\\.b"])
    expect(destinationsOf("[a](<C:\\a\\.b>)")).toEqual(["link=C:\\a\\.b"])
    expect(destinationsOf('[a](C:\\a\\.b "t")')).toEqual(["link=C:\\a\\.b"])
    expect(destinationsOf("[a](  C:\\a\\.b  )")).toEqual(["link=C:\\a\\.b"])
    // The outer link of a linked image (the image's own url is left alone).
    expect(destinationsOf("[![x](C:\\i\\.p)](C:\\o\\.d)")).toEqual([
      "link=C:\\o\\.d",
      "image=C:\\i.p",
    ])
  })

  it("finds the destination past a `](` that is inside the label", () => {
    // The label holds `](` in a code span. Searching for that sequence instead
    // of asking the tree where the label ends rewrote the wrong text.
    expect(destinationsOf("[x `](C:\\a\\.b` y](C:\\a.b)")).toEqual([
      "link=C:\\a.b",
    ])
    // A title can hold one too, followed by bytes that decode to the url.
    const collision = '[a](https://e.test/C:/a.b "t ](https://e.test/C:/a\\.b")'
    expect(destinationsOf(collision)).toEqual(["link=https://e.test/C:/a.b"])
  })

  it("leaves IMAGE destinations alone entirely", () => {
    // An image's label is a plain string with no position, so its destination
    // could only be guessed — and every guess can be made to take bytes out of
    // a title or an alt code span and rewrite a good REMOTE url. Nothing is
    // lost by declining: harden blocks every local image, so the destination is
    // never used, and a remote one holds no Windows path.
    for (const source of [
      "![alt](C:\\a\\.playwright-cli\\shot.png)",
      "![](C:\\a\\.b)",
      '![x](C:\\a\\.b "a title")',
      // The shapes that made every guessing strategy unsafe: a colliding title,
      // a colliding code span in the alt, and a destination remark decoded from
      // a character reference.
      '![x](https://e.test/C:/a.b "t ](https://e.test/C:/a\\.b")',
      "![x `](https://e.test/C:/a\\.b)` y](https://e.test/C:/a.b)",
      '![x](https://e.test/C:/a&#46;b "t ](https://e.test/C:/a\\.b more")',
      "![alt](https://e.test/x.png)",
    ]) {
      expect(destinationsOf(source)).toEqual(untouchedDestinationsOf(source))
    }
  })

  it("leaves a destination it cannot explain alone", () => {
    // A reference link, whose definition node is never visited.
    expect(destinationsOf("[a][ref]\n\n[ref]: C:\\a\\.b")).toEqual([
      "definition=C:\\a.b",
    ])
  })
})

describe("restorePathSeparators — what it must leave alone", () => {
  it("does not touch a prose escape", () => {
    for (const text of [
      "my\\_var\\_name",
      "\\*bold\\* text",
      "1\\. not a list",
      "50\\% off",
      "\\#not-a-heading",
    ]) {
      expect(restorePathSeparators(text, parse(text))).toBeNull()
    }
  })

  it("never follows a path across whitespace into prose", () => {
    // A backslash arbitrarily far right must not retroactively pull a sentence
    // into the path, so these escapes stay the author's.
    for (const text of [
      "saved to C:\\a\\.b.png and use foo\\_bar",
      "saved to C:\\a\\dir then foo\\_bar",
    ]) {
      expect(repair(text)).toContain("foo_bar")
    }
    // The cost: a path with BOTH a space and a punctuation-initial segment
    // keeps the bug. Pinned so a future attempt at spaces is deliberate.
    expect(repair("C:\\Program Files\\.next\\x")).toBe(
      "C:\\Program Files.next\\x"
    )
  })

  it("leaves an already-correct rendering exactly as it renders", () => {
    // A backslash run of two or more is the author's own escaping and already
    // produces the separator, so nothing may be added to it.
    for (const raw of [
      "C:\\\\Users\\\\.gitconfig",
      "C:\\\\\\.env",
      "C:\\\\\\\\.env",
      "C:\\\\a\\\\\\.b",
      "C:\\\\![alt](url)",
    ]) {
      expect(restorePathSeparators(raw, parse(raw))).toBeNull()
    }
  })

  it("does not treat an escape of a non-path character as a separator", () => {
    // `*`, `"`, `?` cannot be in a Windows file name, so `\*` is the author's
    // escape and `C:\\\*b*` must keep rendering `C:\*b*`.
    for (const raw of ["C:\\\\\\*b*", 'C:\\\\\\"q"', "C:\\\\\\?x"]) {
      expect(restorePathSeparators(raw, parse(raw))).toBeNull()
    }
  })

  it("does not read a URL scheme as a drive letter", () => {
    for (const text of ["http://example.com/a\\.b", "see ftp://host/p"]) {
      expect(restorePathSeparators(text, parse(text))).toBeNull()
    }
  })

  it("only takes a UNC or `.\\` anchor at a word boundary", () => {
    // `A\\B\_C` renders `A\B_C` — the `\\` is an escaped backslash mid-token,
    // not a path prefix, so nothing in it is a separator.
    for (const text of ["A\\\\B\\_C", "x.\\y\\_z"]) {
      expect(restorePathSeparators(text, parse(text))).toBeNull()
    }
    // At a boundary they are anchors again.
    expect(repair("见 \\\\srv\\share\\.env")).toBe("见 \\srv\\share\\.env")
    expect(repair("run .\\scripts\\.env")).toBe("run .\\scripts\\.env")
  })

  it("declines a value the escape rule alone does not explain", () => {
    // A character reference means the value came from more than escaping;
    // guessing there could corrupt it, so the node is left alone.
    expect(
      restorePathSeparators("C:\\a\\.b &amp; more", "C:\\a.b & more")
    ).toBeNull()
  })

  it("returns null when there is nothing to repair", () => {
    expect(restorePathSeparators("no backslashes", "no backslashes")).toBeNull()
    expect(restorePathSeparators("C:/a/.b", "C:/a/.b")).toBeNull()
    expect(restorePathSeparators("", "")).toBeNull()
  })
})
