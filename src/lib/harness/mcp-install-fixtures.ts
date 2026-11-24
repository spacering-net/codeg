/**
 * The install commands' answers for tests, as the backend puts them on the
 * wire (h4-api.md): snake_case, with the catalog's `snapshot` and `latest` in
 * camelCase. Each builder takes the fields a test cares about.
 */
type Json = Record<string, unknown>

export const STATE = "a1".repeat(32)
export const NEW_STATE = "b2".repeat(32)

export function rawSnapshot(overrides: Json = {}): Json {
  return {
    revision: 3,
    status: "ok",
    risk: "low",
    reviewed: true,
    permissions: {
      declared: {
        runsCode: ["node"],
        installs: [],
        installScripts: [],
        network: ["api.acme.example"],
        secrets: ["NOTES_TOKEN"],
        paths: [],
        tools: [],
      },
      detected: {
        runsCode: ["node"],
        installs: ["npm"],
        installScripts: [],
        network: ["api.acme.example", "telemetry.acme.example"],
        secrets: ["NOTES_TOKEN"],
        paths: [],
        tools: [],
      },
    },
    checks: {
      findings: { low: 2, medium: 1, high: 0 },
      secrets: 0,
      review: "done",
    },
    packages: [
      {
        registryType: "npm",
        identifier: "@acme/notes-mcp",
        version: "1.2.0",
        verified: "ok",
        hasInstallScript: false,
      },
    ],
    stateSha256: STATE,
    ...overrides,
  }
}

export function rawParameter(overrides: Json = {}): Json {
  return {
    key: "env.NOTES_TOKEN",
    name: "NOTES_TOKEN",
    location: "env",
    description: "Your Notes API token.",
    required: true,
    secret: true,
    kind: "string",
    default: null,
    placeholder: null,
    choices: [],
    current: null,
    ...overrides,
  }
}

export function rawStdioOption(overrides: Json = {}): Json {
  return {
    id: "official:package:0:stdio",
    transport: "stdio",
    source: "package",
    package: {
      registry_type: "npm",
      identifier: "@acme/notes-mcp",
      version: "1.2.0",
      verified: "ok",
      has_install_script: false,
      runtime: "npx",
    },
    definition: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@acme/notes-mcp@1.2.0"],
      env: { NOTES_DIR: "~/notes" },
    },
    url: null,
    parameters: [
      rawParameter(),
      rawParameter({
        key: "env.NOTES_DIR",
        name: "NOTES_DIR",
        description: "Where notes are kept.",
        required: false,
        secret: false,
        default: "~/notes",
      }),
    ],
    blocking: [],
    warnings: [],
    selectable: true,
    default_targets: ["claude_code", "codex"],
    default_replace: [],
    recovery: null,
    ...overrides,
  }
}

export function rawRemoteOption(overrides: Json = {}): Json {
  return {
    id: "official:remote:0:http",
    transport: "http",
    source: "remote",
    package: null,
    definition: {
      type: "http",
      url: "https://notes.acme.example/mcp",
      headers: {},
    },
    url: "https://notes.acme.example/mcp",
    parameters: [
      rawParameter({
        key: "headers.Authorization",
        name: "Authorization",
        location: "header",
        description: "Bearer token.",
        required: true,
        secret: true,
      }),
    ],
    blocking: [],
    warnings: [],
    selectable: true,
    default_targets: ["claude_code", "codex"],
    default_replace: [],
    recovery: null,
    ...overrides,
  }
}

export function rawPlanAgent(agent: string, overrides: Json = {}): Json {
  return {
    agent,
    installed: true,
    writable: true,
    transports: ["stdio", "http", "sse"],
    path: `/home/u/.${agent}/config.json`,
    status: "ok",
    basis: `basis-${agent}`,
    keys: [],
    reason: null,
    entries: [],
    ...overrides,
  }
}

/** Claude Code and Codex installed and writable; Gemini not installed;
 *  Cline's file unreadable. */
export function rawPlanAgents(): Json[] {
  return [
    rawPlanAgent("claude_code"),
    rawPlanAgent("codex", { transports: ["stdio", "http"] }),
    rawPlanAgent("gemini", { installed: false }),
    rawPlanAgent("cline", {
      writable: false,
      status: "unreadable",
      basis: null,
    }),
  ]
}

export function rawPlan(overrides: Json = {}): Json {
  const agents = (overrides.agents as Json[] | undefined) ?? rawPlanAgents()
  const basis: Record<string, string> = {}
  for (const agent of agents) {
    if (typeof agent.basis === "string")
      basis[String(agent.agent)] = agent.basis
  }
  return {
    item: {
      id: "item-notes",
      ref: "acme.dev/notes",
      kind: "mcp",
      title: { en: "Acme Notes", zh: "Acme 笔记" },
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
    snapshot: rawSnapshot(),
    state_sha256: STATE,
    blocking: [],
    confirm: [],
    options: [rawStdioOption(), rawRemoteOption()],
    default_option: "official:package:0:stdio",
    key: {
      name: "notes",
      default: "notes",
      conflicts: [],
      pattern: "^[A-Za-z0-9_-]{1,64}$",
    },
    agents,
    basis,
    installed: null,
    ...overrides,
  }
}

export function rawInstalledAgent(agent: string, overrides: Json = {}): Json {
  return {
    agent,
    state: "as_installed",
    revision: 3,
    version: "1.2.0",
    option: "official:package:0:stdio",
    transport: "stdio",
    packages: [
      { registry_type: "npm", identifier: "@acme/notes-mcp", version: "1.2.0" },
    ],
    state_sha256: STATE,
    installed_at: "2026-11-16T09:30:00.000Z",
    ...overrides,
  }
}

export function rawInstalledItem(overrides: Json = {}): Json {
  return {
    id: "item-notes",
    ref: "acme.dev/notes",
    title: { en: "Acme Notes" },
    key: "notes",
    revision: 3,
    version: "1.2.0",
    state: "as_installed",
    agents: [rawInstalledAgent("claude_code")],
    ...overrides,
  }
}

export function rawApply(
  outcome: string,
  agents: string[],
  status: string,
  overrides: Json = {}
): Json {
  return {
    outcome,
    ok: outcome === "applied" || outcome === "preflight",
    agents: agents.map((agent) => ({
      agent,
      path: `/home/u/.${agent}/config.json`,
      status,
      basis: `basis-${agent}-after`,
      issues: [],
      warnings: [],
      ops: [{ index: 0, key: "notes", effect: "created" }],
      writes: [
        {
          path: `/home/u/.${agent}/config.json`,
          role: "servers",
          creates: false,
        },
      ],
      backup_paths: [],
    })),
    ...overrides,
  }
}

export function rawInstallResult(outcome: string, overrides: Json = {}): Json {
  return {
    outcome,
    issues: [],
    changes: [],
    snapshot: null,
    state_sha256: null,
    apply: null,
    record: null,
    ...overrides,
  }
}
