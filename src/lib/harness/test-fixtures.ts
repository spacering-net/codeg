/**
 * Catalog answers for tests, shaped as the API sends them (raw JSON, before
 * `normalize.ts`). Only imported by tests.
 */

type Json = Record<string, unknown>

export function rawSummary(overrides: Json = {}): Json {
  return {
    id: "0199b5e2-0000-7000-8000-000000000001",
    ref: "acme/pdf-tools",
    name: "pdf-tools",
    kind: "skill",
    status: "public",
    title: { en: "PDF Tools", zh: "PDF 工具" },
    summary: { en: "Fill and sign PDF forms.", zh: "填写并签署 PDF 表单。" },
    publisher: {
      handle: "acme",
      name: "Acme",
      kind: "github",
      verified: false,
      unclaimed: true,
      avatar: "/api/avatars/0199b5e2/4f1c2a9e.png",
    },
    tags: ["files"],
    runtime: "python",
    risk: "low",
    reviewed: false,
    featured: false,
    source: "github",
    repoStars: 1234,
    stars: 0,
    installs: 0,
    latest: {
      revision: 3,
      version: "1.2.0",
      publishedAt: "2026-10-20T08:00:00.000Z",
    },
    ...overrides,
  }
}

/** `count` summaries with distinct ids and addresses, numbered from `from`. */
export function rawSummaries(count: number, from = 1): Json[] {
  return Array.from({ length: count }, (_, index) => {
    const n = from + index
    return rawSummary({
      id: `item-${n}`,
      ref: `acme/item-${n}`,
      name: `item-${n}`,
      title: { en: `Item ${n}` },
    })
  })
}

export function rawList(
  // `unknown`: a test may put in entries that are not items at all.
  items: unknown[],
  next: string | null = null,
  approxTotal: number | null = items.length
): Json {
  return { items, next, approxTotal }
}

export function rawDetail(overrides: Json = {}): Json {
  const summary = rawSummary(overrides)
  return {
    ...summary,
    license: "Apache-2.0",
    repositoryUrl: "https://github.com/acme/skills",
    websiteUrl: "https://acme.example",
    sourceUrl: "https://github.com/acme/skills/tree/abc123/pdf-tools",
    listedReasons: [],
    permissions: {
      declared: { network: ["api.acme.example"] },
      detected: {
        runsCode: ["python"],
        installs: ["pip"],
        installScripts: [],
        network: ["api.acme.example", "telemetry.acme.example"],
        secrets: [],
        paths: [],
        tools: [],
      },
    },
    checks: {
      findings: [],
      review: "off",
      rules: "4024fe4c",
      checkedAt: "2026-10-21T01:17:27.763Z",
      secrets: 0,
      warnings: [],
      dropped: [],
    },
    readme: `/api/harness/v1/items/${String(summary.ref)}/readme`,
    install: {
      item: {
        id: summary.id,
        ref: summary.ref,
        kind: summary.kind,
        title: summary.title,
      },
      version: {
        revision: 3,
        version: "1.2.0",
        publishedAt: "2026-10-20T08:00:00.000Z",
        status: "ok",
      },
      archive: {
        url: "/api/harness/v1/archives/9f2c.zip",
        sha256: "9f2c",
        size: 48213,
      },
      files: [
        { path: "SKILL.md", sha256: "aa", size: 2201, executable: false },
        { path: "scripts/fill.py", sha256: "bb", size: 5120, executable: true },
      ],
      source: null,
      permissions: {
        runsCode: ["python"],
        installs: ["pip"],
        installScripts: [],
        network: ["api.acme.example"],
        secrets: [],
        paths: [],
        tools: [],
      },
      risk: "low",
      reviewed: false,
      advisories: [],
    },
    ...overrides,
  }
}

/** A file hash as the catalog writes one: 64 lower-case hex digits. */
export function fileHash(digit: string): string {
  return digit.repeat(64).slice(0, 64)
}

/** A result made with a prompt, numbered `n`. */
export function rawShowcase(n: number, overrides: Json = {}): Json {
  return {
    by: { name: `sharer${n}`, url: `https://x.com/sharer${n}` },
    link: `https://x.com/sharer${n}/status/21032730035554${String(n).padStart(5, "0")}`,
    cover: `/api/harness/v1/media/${fileHash(String(n % 10))}.webp`,
    motion: `/api/harness/v1/media/${fileHash("f")}.webp`,
    category: "motion",
    categoryName: { en: "Motion graphics", zh: "动态图形" },
    labels: ["threejs"],
    at: "2026-09-28T10:00:00.000Z",
    ...overrides,
  }
}

/** The text of the prompt in `rawPromptDetail`: lines of its own, and
 *  markup that must stay text. */
export const PROMPT_TEXT =
  "<inputs>\nAsk me for: the product name and a one-line promise.\n</inputs>\n\n" +
  "Make a 15-second motion graphics video that shows what it does.\n" +
  'Keep it **bold** & <b class="loud">simple</b>.'

/**
 * A prompt's item, as `harness_item` answers for one — the shape of the live
 * catalog's (yihui-dev's collection). `prompt` patches `install.prompt`.
 */
export function rawPromptDetail(prompt: Json = {}, overrides: Json = {}): Json {
  const base = rawDetail({
    id: "0199b5e2-0000-7000-8000-000000000002",
    ref: "yihui-dev/twoclipping-402193",
    name: "twoclipping-402193",
    kind: "prompt",
    title: { en: "Ask me for: the product name and a one-line promise." },
    summary: {},
    publisher: {
      handle: "yihui-dev",
      name: "yihui-dev",
      kind: "github",
      verified: false,
      unclaimed: true,
      avatar: null,
    },
    tags: ["video", "animation"],
    runtime: "none",
    license: null,
    repositoryUrl: "https://github.com/yihui-dev/awesome-opus5-5-videos",
    websiteUrl: null,
    sourceUrl:
      "https://github.com/yihui-dev/awesome-opus5-5-videos/blob/3d54892/data/videos.json",
    readme: null,
    prompt: {
      excerpt: "<inputs> Ask me for: the product name and a one-line promise.",
      cover: null,
      motion: null,
      model: "claude-opus-5-5",
      by: "sharer1",
      results: 2,
      partial: false,
    },
  })
  return {
    ...base,
    permissions: { declared: {}, detected: emptyPermissions() },
    install: {
      ...(base.install as Json),
      files: [
        {
          path: "PROMPT.md",
          sha256: fileHash("a"),
          size: 2885,
          executable: false,
        },
      ],
      permissions: emptyPermissions(),
      prompt: {
        text: PROMPT_TEXT,
        model: "claude-opus-5-5",
        argumentHint: null,
        partial: false,
        rights: "creators",
        lang: "en",
        showcases: [rawShowcase(1), rawShowcase(2, { motion: null })],
        ...prompt,
      },
    },
    ...overrides,
  }
}

function emptyPermissions(): Json {
  return {
    runsCode: [],
    installs: [],
    installScripts: [],
    network: [],
    secrets: [],
    paths: [],
    tools: [],
  }
}

/** The definition file of the assistant in `rawAssistantDetail`. */
export const DEFINITION_HASH = fileHash("d")

/**
 * An assistant's item, as `harness_item` answers for one: Anthropic's
 * silent-failure-hunter, with the rest of what a definition can carry filled
 * in. `assistant` patches `install.assistant`.
 */
export function rawAssistantDetail(
  assistant: Json = {},
  overrides: Json = {}
): Json {
  const base = rawDetail({
    id: "0199b5e2-0000-7000-8000-000000000003",
    ref: "anthropics/silent-failure-hunter",
    name: "silent-failure-hunter",
    kind: "assistant",
    title: { en: "Silent failure hunter" },
    summary: {
      en: "Use this agent when reviewing code changes in a pull request to identify silent failures.",
    },
    publisher: {
      handle: "anthropics",
      name: "anthropics",
      kind: "github",
      verified: true,
      unclaimed: false,
      avatar: null,
    },
    tags: ["code-review"],
    runtime: "none",
    license: "Apache-2.0",
    repositoryUrl: "https://github.com/anthropics/claude-plugins-official",
    readme: "/api/harness/v1/items/anthropics/silent-failure-hunter/readme",
  })
  return {
    ...base,
    permissions: {
      declared: { tools: ["Read", "Grep", "mcp__github__*"] },
      detected: { ...emptyPermissions(), tools: ["Read", "Grep", "Bash"] },
    },
    install: {
      ...(base.install as Json),
      files: [
        {
          path: "silent-failure-hunter.md",
          sha256: DEFINITION_HASH,
          size: 7807,
          executable: false,
        },
      ],
      permissions: emptyPermissions(),
      assistant: {
        name: "silent-failure-hunter",
        file: "silent-failure-hunter.md",
        description: "Use this agent when reviewing code changes.",
        model: "sonnet",
        tools: ["Read", "Grep", "Edit", "mcp__github__*", "TodoWrite"],
        disallowedTools: ["Bash(rm:*)"],
        access: {
          read: true,
          edit: true,
          run: false,
          web: false,
          all: false,
        },
        color: "yellow",
        skills: [
          { name: "pdf", ref: "anthropics/pdf" },
          { name: "house-style", ref: null },
        ],
        mcpServers: ["github"],
        mcpLaunches: ["local-index"],
        permissionMode: "acceptEdits",
        hooks: true,
        starters: [
          "I've added error handling to the API client. Can you review it?",
          "Hunt for swallowed errors in src/",
        ],
        examples: [
          {
            context:
              "Daisy has just finished a feature that fetches data with a fallback.",
            user: "I've added error handling to the API client. Can you review it?",
            assistant:
              '"Let me use the silent-failure-hunter agent." <Task tool invocation to launch silent-failure-hunter agent>',
            commentary: "Error handling was added, so it is checked at once.",
          },
        ],
        vibe: "Finds the errors your code swallows.",
        emoji: "🕵️",
        settings: { effort: "high", maxTurns: 15 },
        plugin: "pr-review-toolkit",
        alsoIn: ["code-review", "quality"],
        ...assistant,
      },
    },
    ...overrides,
  }
}

export function rawVersions(): Json[] {
  return [
    {
      revision: 3,
      version: "1.2.0",
      status: "ok",
      risk: "low",
      publishedAt: "2026-10-20T08:00:00.000Z",
    },
    {
      revision: 2,
      version: "1.1.0",
      status: "yanked",
      risk: "low",
      publishedAt: "2026-09-01T08:00:00.000Z",
    },
  ]
}

export function rawConfig(): Json {
  return {
    limits: {},
    kinds: ["skill", "mcp", "prompt", "assistant", "connector"],
    sorts: ["popular", "new", "updated"],
    runtimes: [
      { id: "node", count: 10 },
      { id: "python", count: 5 },
      { id: "remote", count: 3 },
    ],
    tags: [
      { id: "database", name: { en: "Databases", zh: "数据库" }, count: 4 },
      { id: "files", name: { en: "Files", zh: "文件" }, count: 2 },
    ],
    review: "off",
  }
}

/** A backend failure as the transports deliver it: an `AppCommandError`
 *  stamped with a `Harness.errors.*` key. */
export function backendError(kind: string, params?: Record<string, string>) {
  return {
    code: "network_error",
    message: `harness ${kind}`,
    i18n_key: `Harness.errors.${kind}`,
    i18n_params: params ?? null,
  }
}
