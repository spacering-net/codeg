// Map file extensions to Monaco editor language IDs.
//
// All values must be valid IDs registered by monaco-editor's basic-languages
// contribution; unknown IDs are silently treated as plaintext by Monaco, which
// is misleading for callers — so we prefer "plaintext" over a wrong-but-close
// mapping (e.g. Groovy is NOT mapped to "java", Zig is NOT mapped to "rust").
//
// .toml is mapped to "ini" as a best-effort approximation; TOML supports
// nested tables and typed values that ini grammar does not understand, but
// partial highlighting is preferable to plain text for this widely-used format.
const EXTENSION_MAP: Record<string, string> = {
  // TypeScript / JavaScript
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",

  // Systems
  rs: "rust",
  go: "go",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  "c++": "cpp",
  hh: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  cs: "csharp",
  fs: "fsharp",
  fsx: "fsharp",
  fsi: "fsharp",
  vb: "vb",

  // JVM
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  sc: "scala",
  clj: "clojure",
  cljs: "clojure",
  cljc: "clojure",

  // Scripting
  py: "python",
  pyw: "python",
  pyi: "python",
  rb: "ruby",
  rake: "ruby",
  php: "php",
  pl: "perl",
  pm: "perl",
  lua: "lua",
  r: "r",
  jl: "julia",
  dart: "dart",
  swift: "swift",
  m: "objective-c",
  mm: "objective-c",
  ex: "elixir",
  exs: "elixir",

  // Shell
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  bat: "bat",
  cmd: "bat",

  // Data / config
  json: "json",
  jsonc: "json",
  json5: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  conf: "ini",
  cfg: "ini",
  env: "ini",
  properties: "ini",
  xml: "xml",
  xsd: "xml",
  xsl: "xml",
  plist: "xml",
  svg: "xml",
  proto: "proto",
  graphql: "graphql",
  gql: "graphql",

  // Markup
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
  rst: "restructuredtext",

  // Web
  html: "html",
  htm: "html",
  vue: "html",
  svelte: "html",
  hbs: "handlebars",
  handlebars: "handlebars",
  twig: "twig",
  pug: "pug",
  jade: "pug",
  liquid: "liquid",
  razor: "razor",
  cshtml: "razor",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",

  // Database
  sql: "sql",
  pgsql: "pgsql",
  mysql: "mysql",
  redis: "redis",

  // Misc
  dockerfile: "dockerfile",
  sol: "sol",
  tf: "hcl",
  tfvars: "hcl",
  hcl: "hcl",
  cypher: "cypher",
  cql: "cypher",
  wgsl: "wgsl",
  abap: "abap",
  apex: "apex",
  bicep: "bicep",
}

// Filenames without a meaningful extension (or whose full basename carries the
// language signal) — e.g. Dockerfile, Gemfile, .bashrc.
const BASENAME_MAP: Record<string, string> = {
  // Container
  dockerfile: "dockerfile",
  containerfile: "dockerfile",

  // Ruby tooling conventions
  gemfile: "ruby",
  rakefile: "ruby",
  podfile: "ruby",
  brewfile: "ruby",
  vagrantfile: "ruby",

  // Shell rc/profile dotfiles
  ".bashrc": "shell",
  ".bash_profile": "shell",
  ".bash_login": "shell",
  ".bash_logout": "shell",
  ".zshrc": "shell",
  ".zshenv": "shell",
  ".zprofile": "shell",
  ".zlogin": "shell",
  ".zlogout": "shell",
  ".profile": "shell",
  ".inputrc": "shell",
}

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "bmp",
  "ico",
])

// Images render via base64 preview and carry no etag — callers branch on
// this before any etag-based disk reconciliation.
export function isImageFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  return IMAGE_EXTENSIONS.has(ext)
}

// Images git can only diff as binary — the ones a text diff has nothing to say
// about, so the diff surfaces render them as pictures instead. `.svg` is
// deliberately excluded: it is text, `git diff` produces a real line diff for
// it, and that diff says more than two pictures that may look identical.
export function isBinaryImageFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  return ext !== "svg" && IMAGE_EXTENSIONS.has(ext)
}

// HTML documents we can render in the in-app sandboxed preview. Scoped to real
// .html/.htm files — .vue/.svelte also map to the "html" language but are not
// standalone, renderable documents.
export function isHtmlPreviewable(path: string | null | undefined): boolean {
  if (!path) return false
  const basename = path.toLowerCase().split(/[\\/]/).pop() ?? ""
  const dot = basename.lastIndexOf(".")
  if (dot === -1) return false
  const ext = basename.slice(dot + 1)
  return ext === "html" || ext === "htm"
}

// Office documents (.docx/.xlsx/.pptx) we can render in the in-app preview via
// the OfficeCLI backend. These are binary OpenXML files — there is no text
// editor view, so a matching tab is always preview-only.
export function isOfficePreviewable(path: string | null | undefined): boolean {
  if (!path) return false
  const basename = path.toLowerCase().split(/[\\/]/).pop() ?? ""
  const dot = basename.lastIndexOf(".")
  if (dot === -1) return false
  const ext = basename.slice(dot + 1)
  return ext === "docx" || ext === "xlsx" || ext === "pptx"
}

/**
 * True when the file name is a Microsoft Office / WPS *owner file* — the
 * `~$`-prefixed sidecar those suites drop beside a document the moment it is
 * opened for editing, recording who holds it so a second opener gets the "file
 * in use" dialog. It inherits the document's own extension (`~$report.docx`),
 * so the office-extension filter alone waves it straight through.
 *
 * These track an external editing session rather than anything the agent did:
 * opening a folder of documents in WPS drops one per document at once, and
 * automatic surfacing would answer with a tab — and an `officecli watch`
 * process — for every one. They are not documents either, just a few hundred
 * bytes of owner metadata rather than OpenXML, so those tabs could only fail.
 *
 * The `~$` prefix is the whole test: Word, Excel, PowerPoint and the WPS suite
 * that mirrors them all reserve it for this, and the rest of the name is the
 * original's, truncated by rules that vary by suite and name length. Only the
 * file name is examined — a directory is never an owner file, and one that
 * happened to start with `~$` should not disqualify the documents beneath it.
 * Dot-tilde spellings (LibreOffice's `.~lock.report.docx#`) are hidden by name
 * and belong to `isHiddenPath` below.
 */
export function isOfficeOwnerFile(path: string | null | undefined): boolean {
  if (!path) return false
  const basename = path.split(/[\\/]/).pop() ?? ""
  return basename.startsWith("~$")
}

/**
 * True when any segment of `path` is dot-prefixed — the conventional marker
 * for a hidden or machine-owned file: LibreOffice's `.~lock.report.docx#`,
 * macOS AppleDouble sidecars (`._report.docx`), and anything parked under
 * `.git/`, `.tmp/`, `.venv/` and friends. Those are byproducts, not documents
 * a user asked for, so automatic surfacing (watch + preview) skips them.
 *
 * Every segment is tested, not just the file name: a doc inside a hidden
 * directory is every bit as hidden as a hidden doc. `.` and `..` are path
 * syntax rather than names and never count as hidden.
 *
 * Both separators are accepted and dot segments are tolerated so the predicate
 * holds for any path shape. The workspace watcher happens to hand us neither
 * (`classify_watch_path` strips the root and slash-normalizes before emitting
 * `changed_paths`), so that part is headroom for other callers, not a
 * requirement of today's one.
 */
export function isHiddenPath(path: string | null | undefined): boolean {
  if (!path) return false
  return path
    .split(/[\\/]/)
    .some(
      (segment) =>
        segment.startsWith(".") && segment !== "." && segment !== ".."
    )
}

export function languageFromPath(path: string): string {
  const lower = path.toLowerCase()
  const basename = lower.split(/[\\/]/).pop() ?? lower

  if (BASENAME_MAP[basename]) {
    return BASENAME_MAP[basename]
  }

  // Dockerfile.dev / Dockerfile.prod / Dockerfile.test — common multi-stage
  // naming where the suffix is the build target rather than a file extension.
  if (basename.startsWith("dockerfile.")) {
    return "dockerfile"
  }

  const dotIdx = basename.lastIndexOf(".")
  if (dotIdx === -1 || dotIdx === basename.length - 1) {
    return "plaintext"
  }
  const ext = basename.slice(dotIdx + 1)
  return EXTENSION_MAP[ext] ?? "plaintext"
}
