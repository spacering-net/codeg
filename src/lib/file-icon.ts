const COLLECTION = "material-icon-theme"

const EXACT_NAMES: Record<string, string> = {
  dockerfile: "docker",
  "docker-compose.yml": "docker",
  "docker-compose.yaml": "docker",
  "cargo.toml": "rust",
  "cargo.lock": "lock",
  "package.json": "npm",
  "package-lock.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "pnpm-workspace.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lockb": "bun",
  "bun.lock": "bun",
  "deno.lock": "deno",
  "tsconfig.json": "tsconfig",
  "jsconfig.json": "jsconfig",
  ".editorconfig": "editorconfig",
  ".gitignore": "git",
  ".gitattributes": "git",
  ".gitmodules": "git",
  ".gitkeep": "git",
  ".npmrc": "npm",
  ".nvmrc": "nodejs",
  license: "license",
  licence: "license",
  readme: "markdown",
  makefile: "makefile",
  "cmakelists.txt": "cmake",
  ".eslintrc": "eslint",
  ".prettierrc": "prettier",
}

const PREFIX_NAMES: [string, string][] = [
  ["docker-compose", "docker"],
  ["tsconfig", "tsconfig"],
  ["next.config", "next"],
  ["tailwind.config", "tailwindcss"],
  ["eslint.config", "eslint"],
  [".eslintrc", "eslint"],
  ["prettier.config", "prettier"],
  [".prettierrc", "prettier"],
  ["vite.config", "vite"],
  ["vitest.config", "vitest"],
  ["jest.config", "jest"],
  ["playwright.config", "playwright"],
  [".env", "key"],
]

const EXT_NAMES: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "react-ts",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "react",
  rs: "rust",
  py: "python",
  go: "go",
  json: "json",
  jsonc: "json",
  json5: "json",
  md: "markdown",
  mdx: "markdown",
  html: "html",
  htm: "html",
  css: "css",
  less: "less",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  xml: "xml",
  sql: "database",
  sh: "console",
  bash: "console",
  zsh: "console",
  fish: "console",
  ps1: "powershell",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  ico: "image",
  bmp: "image",
  avif: "image",
  tiff: "image",
  svg: "svg",
  mp4: "video",
  mov: "video",
  avi: "video",
  mkv: "video",
  webm: "video",
  mp3: "audio",
  wav: "audio",
  flac: "audio",
  ogg: "audio",
  m4a: "audio",
  pdf: "pdf",
  zip: "zip",
  gz: "zip",
  tar: "zip",
  rar: "zip",
  "7z": "zip",
  bz2: "zip",
  xz: "zip",
  woff: "font",
  woff2: "font",
  ttf: "font",
  otf: "font",
  eot: "font",
  lock: "lock",
  txt: "document",
  log: "document",
  graphql: "graphql",
  gql: "graphql",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  php: "php",
  rb: "ruby",
  cs: "csharp",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  lua: "lua",
  pl: "perl",
  hs: "haskell",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  clj: "clojure",
  scala: "scala",
  dart: "dart",
  svelte: "svelte",
  vue: "vue",
  astro: "astro",
}

/**
 * Maps a filename to a Material Icon Theme icon name,
 * or null when no matching icon exists (caller should fall back to a generic icon).
 */
export function getFileIconName(filename: string): string | null {
  const base = filename.split("/").pop()?.toLowerCase() ?? ""

  const exact = EXACT_NAMES[base]
  if (exact) return `${COLLECTION}:${exact}`

  const stem = base.replace(/\.[^.]+$/, "")
  for (const [prefix, name] of PREFIX_NAMES) {
    if (base.startsWith(prefix) || stem.startsWith(prefix)) {
      return `${COLLECTION}:${name}`
    }
  }

  const dtsMatch = /\.d\.ts$/.test(base)
  if (dtsMatch) return `${COLLECTION}:typescript-def`

  const ext = base.includes(".") ? base.split(".").pop()! : ""
  const name = EXT_NAMES[ext]
  if (name) return `${COLLECTION}:${name}`

  return null
}
