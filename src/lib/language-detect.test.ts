import { describe, expect, it } from "vitest"

import {
  isHiddenPath,
  isOfficeOwnerFile,
  isPdfFile,
  languageFromPath,
} from "./language-detect"

describe("languageFromPath", () => {
  // The original implementation was a 13-case switch. These cases lock that
  // behaviour so future map edits cannot silently regress it.
  describe("original switch cases preserved", () => {
    it.each([
      ["foo.ts", "typescript"],
      ["foo.tsx", "typescript"],
      ["foo.js", "javascript"],
      ["foo.mjs", "javascript"],
      ["foo.cjs", "javascript"],
      ["foo.jsx", "javascript"],
      ["foo.rs", "rust"],
      ["foo.py", "python"],
      ["foo.go", "go"],
      ["foo.json", "json"],
      ["foo.md", "markdown"],
      ["foo.yml", "yaml"],
      ["foo.yaml", "yaml"],
      ["foo.css", "css"],
      ["foo.html", "html"],
      ["foo.htm", "html"],
      ["foo.sh", "shell"],
      ["foo.sql", "sql"],
    ])("%s -> %s", (path, expected) => {
      expect(languageFromPath(path)).toBe(expected)
    })

    // .toml used to return "toml" which Monaco does not recognise (silently
    // treated as plaintext). It now maps to "ini" as a best-effort fallback.
    it("toml now maps to ini (intentional behaviour change)", () => {
      expect(languageFromPath("Cargo.toml")).toBe("ini")
    })
  })

  describe("newly supported languages", () => {
    it.each([
      ["Main.java", "java"],
      ["App.kt", "kotlin"],
      ["build.gradle.kts", "kotlin"],
      ["script.rb", "ruby"],
      ["index.php", "php"],
      ["Program.cs", "csharp"],
      ["main.cpp", "cpp"],
      ["util.hpp", "cpp"],
      ["main.c", "c"],
      ["main.h", "c"],
      ["lib.swift", "swift"],
      ["util.dart", "dart"],
      ["pipeline.scala", "scala"],
      ["app.lua", "lua"],
      ["stats.r", "r"],
      ["app.ex", "elixir"],
      ["analysis.jl", "julia"],
      ["deploy.ps1", "powershell"],
      ["styles.scss", "scss"],
      ["styles.less", "less"],
      ["query.graphql", "graphql"],
      ["query.gql", "graphql"],
      ["contract.sol", "sol"],
      ["main.tf", "hcl"],
      ["service.proto", "proto"],
      ["doc.mdx", "mdx"],
      ["AppDelegate.m", "objective-c"],
      ["Cargo.toml", "ini"],
      ["config.xml", "xml"],
      ["icon.svg", "xml"],
      ["script.bat", "bat"],
      ["app.fs", "fsharp"],
    ])("%s -> %s", (path, expected) => {
      expect(languageFromPath(path)).toBe(expected)
    })
  })

  describe("basename detection (no extension)", () => {
    it("matches Dockerfile by basename", () => {
      expect(languageFromPath("Dockerfile")).toBe("dockerfile")
      expect(languageFromPath("dockerfile")).toBe("dockerfile")
      expect(languageFromPath("path/to/Dockerfile")).toBe("dockerfile")
      expect(languageFromPath("Containerfile")).toBe("dockerfile")
    })

    it("matches Dockerfile variants by prefix", () => {
      expect(languageFromPath("Dockerfile.dev")).toBe("dockerfile")
      expect(languageFromPath("Dockerfile.prod")).toBe("dockerfile")
      expect(languageFromPath("Dockerfile.test")).toBe("dockerfile")
    })

    it("matches *.dockerfile extension", () => {
      expect(languageFromPath("web.dockerfile")).toBe("dockerfile")
    })

    it("matches Ruby filename conventions", () => {
      expect(languageFromPath("Gemfile")).toBe("ruby")
      expect(languageFromPath("Rakefile")).toBe("ruby")
      expect(languageFromPath("Podfile")).toBe("ruby")
      expect(languageFromPath("Brewfile")).toBe("ruby")
      expect(languageFromPath("Vagrantfile")).toBe("ruby")
    })

    it("matches shell rc/profile dotfiles", () => {
      expect(languageFromPath(".bashrc")).toBe("shell")
      expect(languageFromPath(".bash_profile")).toBe("shell")
      expect(languageFromPath(".zshrc")).toBe("shell")
      expect(languageFromPath(".zshenv")).toBe("shell")
      expect(languageFromPath(".profile")).toBe("shell")
    })
  })

  describe("path normalisation", () => {
    it("handles Windows backslash paths", () => {
      expect(languageFromPath("C:\\Users\\me\\file.rs")).toBe("rust")
      expect(languageFromPath("C:\\code\\Main.java")).toBe("java")
      expect(languageFromPath("D:\\repo\\Dockerfile")).toBe("dockerfile")
    })

    it("handles posix paths with directories", () => {
      expect(languageFromPath("/home/user/src/app.ts")).toBe("typescript")
      expect(languageFromPath("./src/lib/utils.ts")).toBe("typescript")
    })

    it("uses the last segment for multi-dot filenames", () => {
      expect(languageFromPath("component.spec.ts")).toBe("typescript")
      expect(languageFromPath("types.d.ts")).toBe("typescript")
      expect(languageFromPath("module.test.tsx")).toBe("typescript")
    })

    it("is case-insensitive on both extension and basename", () => {
      expect(languageFromPath("README.MD")).toBe("markdown")
      expect(languageFromPath("Main.JAVA")).toBe("java")
      expect(languageFromPath("DOCKERFILE")).toBe("dockerfile")
      expect(languageFromPath("GEMFILE")).toBe("ruby")
    })
  })

  describe("config formats map to ini", () => {
    it.each([
      ["Cargo.toml", "ini"],
      ["config.ini", "ini"],
      ["app.conf", "ini"],
      ["build.cfg", "ini"],
      ["server.properties", "ini"],
      [".env", "ini"],
    ])("%s -> %s", (path, expected) => {
      expect(languageFromPath(path)).toBe(expected)
    })
  })

  describe("falls back to plaintext", () => {
    it.each([
      // Unknown extension
      ["foo.unknownext", "plaintext"],
      // Languages without a Monaco grammar (regression check for invalid IDs
      // like the old tex->latex mapping that silently failed).
      ["paper.tex", "plaintext"],
      ["main.zig", "plaintext"],
      ["script.groovy", "plaintext"],
      ["build.gradle", "plaintext"],
      ["Makefile", "plaintext"],
      // No extension at all
      ["noextension", "plaintext"],
      // Trailing dot (no extension content)
      ["trailing.", "plaintext"],
      // Bare dot or empty
      ["", "plaintext"],
      [".", "plaintext"],
      // Hidden file whose stem isn't a known dotfile
      [".gitignore", "plaintext"],
      [".eslintrc", "plaintext"],
      // Multi-dot hidden file (.env.local has unknown last segment)
      [".env.local", "plaintext"],
    ])("%s -> plaintext", (path) => {
      expect(languageFromPath(path)).toBe("plaintext")
    })
  })
})

describe("isHiddenPath", () => {
  describe("dot-prefixed names are hidden", () => {
    it.each([
      // Hidden file name, at the root of the workspace or nested
      [".report.docx"],
      ["docs/.report.docx"],
      // The byproducts this exists for: macOS AppleDouble sidecars sitting
      // next to a real document, and LibreOffice lock files (which the
      // office-extension filter also rejects — belt and braces).
      ["._report.docx"],
      [".~lock.report.docx#"],
      // Hidden directory anywhere on the way down — the doc inside it is
      // just as hidden as a hidden doc.
      [".git/report.docx"],
      ["build/.tmp/draft.xlsx"],
      // Backslashes: the workspace watcher slash-normalizes before emitting,
      // so this is headroom for callers whose paths are not pre-normalized.
      ["docs\\.report.docx"],
      [".tmp\\draft.xlsx"],
    ])("%s -> hidden", (path) => {
      expect(isHiddenPath(path)).toBe(true)
    })
  })

  describe("ordinary paths are not hidden", () => {
    it.each([
      ["report.docx"],
      ["docs/report.docx"],
      ["docs\\report.docx"],
      // A dot mid-name is just a version/extension, not a hidden marker.
      ["docs/report.v2.final.docx"],
      // "." / ".." are path syntax; a leading "./" must not disqualify a doc.
      ["./report.docx"],
      ["../sibling/report.docx"],
      ["./docs/../report.docx"],
      // Absolute forms split to an empty leading segment, not a dot one.
      ["/repo/report.docx"],
      ["C:/repo/report.docx"],
    ])("%s -> visible", (path) => {
      expect(isHiddenPath(path)).toBe(false)
    })
  })

  it("treats empty and nullish input as not hidden", () => {
    expect(isHiddenPath("")).toBe(false)
    expect(isHiddenPath(null)).toBe(false)
    expect(isHiddenPath(undefined)).toBe(false)
  })
})

describe("isOfficeOwnerFile", () => {
  describe("`~$`-prefixed names are owner files", () => {
    it.each([
      // The whole Office family, since each suite writes one for its own
      // document type and all three reach auto-preview.
      ["~$report.docx"],
      ["~$budget.xlsx"],
      ["~$deck.pptx"],
      // Nested, and under both separators — WPS on Windows is where this was
      // reported, so the backslash form is the reported shape, not headroom.
      ["docs/~$report.docx"],
      ["docs\\~$report.docx"],
      ["C:\\Users\\me\\Documents\\~$report.docx"],
      // Word truncates the leading characters of long names to make room for
      // the prefix, so the tail rarely matches the document it belongs to.
      ["~$cument.docx"],
      // Legacy binary formats and stray extensions still name the owner file
      // the same way. Auto-preview rejects these on extension anyway; the
      // predicate answers about the name alone so it stays true wherever the
      // two filters are composed in the other order.
      ["~$report.doc"],
      ["~$notes.txt"],
      ["~$"],
    ])("%s -> owner file", (path) => {
      expect(isOfficeOwnerFile(path)).toBe(true)
    })
  })

  describe("real documents are not owner files", () => {
    it.each([
      ["report.docx"],
      ["docs/report.docx"],
      // A tilde without the dollar sign is an ordinary (if unusual) name —
      // Word's own `~WRD0001.tmp` scratch files are excluded by extension, so
      // widening the prefix here would only cost false positives.
      ["~report.docx"],
      ["~/Documents/report.docx"],
      // The marker only counts at the start of the file name: mid-name, and on
      // a directory, it is somebody's naming choice rather than Office's.
      ["report~$copy.docx"],
      ["~$drafts/report.docx"],
      ["~$drafts\\report.docx"],
      // Dot-tilde is LibreOffice's spelling, caught by `isHiddenPath` instead.
      [".~lock.report.docx#"],
    ])("%s -> document", (path) => {
      expect(isOfficeOwnerFile(path)).toBe(false)
    })
  })

  it("treats empty and nullish input as not an owner file", () => {
    expect(isOfficeOwnerFile("")).toBe(false)
    expect(isOfficeOwnerFile(null)).toBe(false)
    expect(isOfficeOwnerFile(undefined)).toBe(false)
  })
})

describe("isPdfFile", () => {
  it.each([
    ["report.pdf"],
    ["/abs/docs/report.pdf"],
    ["C:\\Users\\me\\Report.PDF"],
    ["archive.tar.pdf"],
  ])("%s -> pdf", (path) => {
    expect(isPdfFile(path)).toBe(true)
  })

  it.each([
    ["report.pdf.txt"],
    ["pdf"],
    [".pdf/notes.md"],
    ["docs.pdf/readme"],
    ["report.docx"],
  ])("%s -> not pdf", (path) => {
    expect(isPdfFile(path)).toBe(false)
  })

  it("treats empty and nullish input as not a pdf", () => {
    expect(isPdfFile("")).toBe(false)
    expect(isPdfFile(null)).toBe(false)
    expect(isPdfFile(undefined)).toBe(false)
  })
})
