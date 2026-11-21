/**
 * The skill install commands' answers for tests, as the backend puts them on
 * the wire (h3-api.md): snake_case, with the catalog's `snapshot` and
 * `latest` in camelCase, and the skills engine's `links` as k1-api §3 has
 * them. Each builder takes the fields a test cares about.
 */
import { rawSnapshot, STATE } from "./mcp-install-fixtures"

type Json = Record<string, unknown>

export { NEW_STATE, STATE } from "./mcp-install-fixtures"

export const ACK_CODEX = "c0".repeat(32)
export const ACK_CODEX_RENAMED = "c1".repeat(32)

/** A skill's snapshot: no packages of its own. */
export function rawSkillSnapshot(overrides: Json = {}): Json {
  return rawSnapshot({ packages: [], ...overrides })
}

export function rawSkillPlanAgent(agent: string, overrides: Json = {}): Json {
  return {
    agent,
    installed: true,
    link_dir: `/home/u/.${agent}/skills`,
    link_dir_shared: false,
    sees: false,
    default: true,
    ...overrides,
  }
}

/** Claude Code installed; Codex installed, linking into a folder others
 *  read; Gemini not installed; Kiro without a folder to link into. */
export function rawSkillPlanAgents(): Json[] {
  return [
    rawSkillPlanAgent("claude_code"),
    rawSkillPlanAgent("codex", {
      link_dir: "/home/u/.agents/skills",
      link_dir_shared: true,
    }),
    rawSkillPlanAgent("gemini", { installed: false, default: false }),
    rawSkillPlanAgent("kiro", { link_dir: null, default: false }),
  ]
}

/** The engine's preflight of `enable` for each agent, under `name`. Codex
 *  links into the shared folder: OpenCode gains it, and the op needs its
 *  ack. */
export function rawLinks(
  agents: readonly string[],
  name = "pdf",
  overrides: Json = {}
): Json {
  return {
    outcome: "preflight",
    ok: true,
    ops: agents.map((agent, index) =>
      agent === "codex"
        ? {
            index,
            skill: name,
            agent,
            action: "enable",
            status: "needs_ack",
            creates: [{ path: `/home/u/.agents/skills/${name}`, kind: "link" }],
            removes: [],
            moves: [],
            gains: ["open_code"],
            loses: [],
            touches: [],
            ack: name === "pdf" ? ACK_CODEX : ACK_CODEX_RENAMED,
            issues: [],
            warnings: [
              {
                code: "shared_directory",
                path: "/home/u/.agents/skills",
                agents: ["open_code"],
              },
            ],
          }
        : {
            index,
            skill: name,
            agent,
            action: "enable",
            status: "ready",
            creates: [
              { path: `/home/u/.${agent}/skills/${name}`, kind: "link" },
            ],
            removes: [],
            moves: [],
            gains: [],
            loses: [],
            touches: [],
            ack: null,
            issues: [],
            warnings: [],
          }
    ),
    issues: [],
    ...overrides,
  }
}

export function rawInstalledSkill(overrides: Json = {}): Json {
  return {
    id: "item-pdf",
    ref: "anthropics/pdf",
    name: "pdf",
    revision: 3,
    version: "1.2.0",
    state: "as_installed",
    agents: ["claude_code"],
    files: { changed: [], added: [], missing: [] },
    rewrites: { allowed_tools: "removed" },
    archive_sha256: "9f".repeat(32),
    state_sha256: STATE,
    installed_at: "2026-11-16T09:30:00.000Z",
    ...overrides,
  }
}

/**
 * A plan for `anthropics/pdf` revision 3. `asked`: the agents the plan was
 * asked about (default: its default ones), which its link preview is for.
 */
export function rawSkillPlan(
  overrides: Json = {},
  asked?: readonly string[] | null
): Json {
  const agents =
    (overrides.agents as Json[] | undefined) ?? rawSkillPlanAgents()
  const defaults =
    (overrides.default_agents as string[] | undefined) ??
    agents
      .filter((agent) => agent.default === true && agent.link_dir !== null)
      .map((agent) => String(agent.agent))
  const name =
    ((overrides.install_name as Json | undefined)?.default as
      | string
      | undefined) ?? "pdf"
  return {
    item: {
      id: "item-pdf",
      ref: "anthropics/pdf",
      kind: "skill",
      title: { en: "PDF Tools", zh: "PDF 工具" },
      revision: 3,
      version: "1.2.0",
      published_at: "2026-11-10T08:00:00.000Z",
    },
    item_status: "public",
    latest: {
      revision: 3,
      version: "1.2.0",
      publishedAt: "2026-11-10T08:00:00.000Z",
    },
    snapshot: rawSkillSnapshot(),
    state_sha256: STATE,
    blocking: [],
    confirm: [],
    warnings: [],
    skill: {
      name: "pdf",
      description: "Read, fill and merge PDF files.",
      license: "MIT",
      compatibility: null,
      allowed_tools: null,
    },
    package: {
      archive: {
        url: "/api/harness/archives/pdf-3.zip",
        sha256: "9f".repeat(32),
        size: 4096,
      },
      source: null,
      files: [
        {
          path: "SKILL.md",
          sha256: "aa".repeat(32),
          size: 1200,
          executable: false,
        },
        {
          path: "scripts/fill.py",
          sha256: "bb".repeat(32),
          size: 2048,
          executable: true,
        },
      ],
      total_bytes: 3248,
      limits: {
        zip_bytes: 10485760,
        total_bytes: 52428800,
        files: 500,
        file_bytes: 10485760,
        depth: 8,
        path_bytes: 200,
        compression_min_bytes: 1048576,
        compression_ratio: 100,
      },
    },
    install_name: {
      name: "pdf",
      default: name,
      taken: [],
      pattern: "^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$",
    },
    agents,
    default_agents: defaults,
    links: rawLinks(asked ?? defaults, name),
    installed: null,
    ...overrides,
  }
}

export function rawSkillInstallResult(
  outcome: string,
  overrides: Json = {}
): Json {
  return {
    outcome,
    issues: [],
    changes: [],
    snapshot: null,
    state_sha256: null,
    name: "pdf",
    phases: [],
    links: null,
    links_skipped: [],
    copies: null,
    backup: null,
    rewrites: null,
    kept: [],
    ...overrides,
  }
}

/** The engine's result of linking `agents`: each op done. */
export function rawLinksApplied(agents: readonly string[], name = "pdf"): Json {
  const preflight = rawLinks(agents, name)
  return {
    outcome: "applied",
    ok: true,
    ops: (preflight.ops as Json[]).map((op) => ({ ...op, status: "done" })),
    issues: [],
  }
}

export function rawSkillUninstallResult(
  outcome: string,
  overrides: Json = {}
): Json {
  return {
    outcome,
    issues: [],
    item_id: "item-pdf",
    name: "pdf",
    removes: [
      {
        path: "/home/u/.claude_code/skills/pdf",
        kind: "link",
        agents: ["claude_code"],
      },
    ],
    loses: ["claude_code"],
    kept_copies: [],
    files: { changed: [], added: [], missing: [] },
    files_unreadable: null,
    keeps_folder: false,
    backup: null,
    ack: outcome === "preflight" ? "ab".repeat(32) : null,
    phases: [],
    kept: [],
    ...overrides,
  }
}
