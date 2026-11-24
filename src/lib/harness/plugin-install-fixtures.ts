/**
 * The plugin install commands' answers for tests, as the backend puts them on
 * the wire (`harness/plugins/model.rs`): snake_case, with the catalog's own
 * objects (members, autorun parts, host manifests, snapshots) in camelCase.
 * The plugin is superpowers-like: two skills, one hook for Claude Code, a
 * pending latest (7.0.2) and an approved `full` (7.0.1). Each builder takes
 * the fields a test cares about.
 */
import { rawSnapshot } from "./mcp-install-fixtures"

type Json = Record<string, unknown>

export const FULL_STATE = "f1".repeat(32)
export const LATEST_STATE = "e2".repeat(32)
export const EXEC = "d3".repeat(32)
export const NEW_EXEC = "d4".repeat(32)
export const EXPERTS_ACK = "c5".repeat(32)
export const ACK_BRAINSTORMING = "c6".repeat(32)

export const MEMBERS: Json[] = [
  {
    kind: "skill",
    name: "brainstorming",
    path: "skills/brainstorming",
    summary: "Turn ideas into designs.",
    treeSha256: "a0".repeat(32),
  },
  {
    kind: "skill",
    name: "writing-plans",
    path: "skills/writing-plans",
    summary: null,
    treeSha256: "a1".repeat(32),
  },
]

export const HOOK: Json = {
  host: "claude",
  type: "hook",
  path: "hooks/hooks.json",
  event: "SessionStart",
  command: "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh",
}

export function rawRevision(
  revision: number,
  version: string,
  overrides: Json = {}
): Json {
  return {
    revision,
    version,
    published_at: "2026-11-19T00:00:00Z",
    name: "superpowers",
    state_sha256: revision === 7 ? FULL_STATE : LATEST_STATE,
    approved: revision === 7,
    exec_sha256: EXEC,
    mcp_unpinned: [],
    members: MEMBERS,
    autorun: [HOOK],
    autorun_files: ["hooks/hooks.json", "hooks/session-start.sh"],
    hosts: [
      {
        host: "claude",
        manifest: ".claude-plugin/plugin.json",
        skills: 2,
        hooks: 1,
      },
      {
        host: "codex",
        manifest: ".codex-plugin/plugin.json",
        skills: 2,
        hooks: 0,
      },
    ],
    archive: {
      url: "/api/harness/v1/archives/x.zip",
      sha256: "ab".repeat(32),
      size: 1000,
    },
    source: null,
    files: [
      {
        path: "hooks/hooks.json",
        sha256: "11".repeat(32),
        size: 120,
        executable: false,
      },
      {
        path: "hooks/session-start.sh",
        sha256: "22".repeat(32),
        size: 300,
        executable: true,
      },
    ],
    total_bytes: 420,
    blocking: [],
    confirm: [],
    warnings: [],
    ...overrides,
  }
}

/** A skills row's preview: one op per member, `brainstorming`'s reaching
 *  another agent (so it has an ack). */
export function rawOwnedPlan(agent: string, overrides: Json = {}): Json {
  return {
    plugin: "superpowers",
    agent,
    links: {
      outcome: "preflight",
      ok: true,
      ops: ["brainstorming", "writing-plans"].map((skill, index) => ({
        index,
        skill,
        agent,
        action: "enable",
        status: skill === "brainstorming" ? "needs_ack" : "ready",
        creates: [{ path: `/home/u/.agents/skills/${skill}`, kind: "link" }],
        removes: [],
        moves: [],
        gains: skill === "brainstorming" ? ["open_code"] : [],
        loses: [],
        touches: [],
        ack: skill === "brainstorming" ? ACK_BRAINSTORMING : null,
        issues: [],
        warnings: [],
      })),
      issues: [],
    },
    takeover: [],
    held: [],
    copies_to_take: [],
    issues: [],
    ...overrides,
  }
}

export function rawPlanHost(agent: string, overrides: Json = {}): Json {
  const hostId =
    agent === "claude_code"
      ? "claude"
      : agent === "codex"
        ? "codex"
        : agent === "open_code"
          ? "opencode"
          : null
  const native = hostId !== null
  return {
    agent,
    host_id: hostId,
    installed: true,
    detect: hostId
      ? {
          found: true,
          via: "wrapper",
          version: "2.1.0",
          supported: true,
          why_not: null,
        }
      : null,
    offered: native ? ["native", "skills", "none"] : ["skills", "none"],
    default: native ? "native" : "skills",
    planned: native ? "native" : "skills",
    why_not: native ? null : { code: "plugin_no_adapter", params: { agent } },
    experts_to_take_over: [],
    experts_ack: null,
    codex_hooks_need_trust: false,
    skills: native ? null : rawOwnedPlan(agent),
    ...overrides,
  }
}

/** The plan with Claude Code as a plugin and Kiro skills only: the target
 *  is `full` (#7), consent is required. */
export function rawPluginPlan(overrides: Json = {}): Json {
  return {
    item: {
      id: "itm_superpowers",
      ref: "obra/superpowers",
      kind: "plugin",
      title: { en: "Superpowers" },
      revision: 8,
      version: "7.0.2",
      published_at: "2026-11-20T00:00:00Z",
    },
    item_status: "public",
    latest: rawRevision(8, "7.0.2", { approved: false, exec_sha256: NEW_EXEC }),
    full: rawRevision(7, "7.0.1"),
    not_full: "pending_review",
    target: 7,
    install_name: "superpowers",
    members: MEMBERS,
    autorun: [HOOK],
    snapshot_latest: rawSnapshot({ revision: 8, stateSha256: LATEST_STATE }),
    snapshot_full: rawSnapshot({ revision: 7, stateSha256: FULL_STATE }),
    hosts: [rawPlanHost("claude_code"), rawPlanHost("kiro")],
    consent_required: true,
    consent_exec: EXEC,
    blocking: [],
    warnings: [],
    installed: null,
    limits: {},
    ...overrides,
  }
}

/** The same plan made for every agent "skills only": the latest (#8). */
export function rawSkillsOnlyPlan(overrides: Json = {}): Json {
  return rawPluginPlan({
    target: 8,
    consent_required: false,
    hosts: [
      rawPlanHost("claude_code", {
        planned: "skills",
        skills: rawOwnedPlan("claude_code"),
      }),
      rawPlanHost("kiro"),
    ],
    ...overrides,
  })
}

// ─── The installed list and the update plan (step 14) ─────────────────

/** One agent of an installed plugin, as `harness_installed` lists it. */
export function rawListedHost(agent: string, overrides: Json = {}): Json {
  const hostId =
    agent === "claude_code"
      ? "claude"
      : agent === "codex"
        ? "codex"
        : agent === "open_code"
          ? "opencode"
          : null
  return {
    agent,
    host_id: hostId,
    mode: "native",
    state: "active",
    suspended_reason: null,
    repair: null,
    host_name: "superpowers",
    skills: [],
    experts: [],
    codex_hooks: false,
    verify: { enabled: true, problems: [] },
    ...overrides,
  }
}

/** superpowers installed at 7.0.1: Claude Code whole, Gemini its skills. */
export function rawListedPlugin(overrides: Json = {}): Json {
  return {
    name: "superpowers",
    item_id: "itm_superpowers",
    ref: "obra/superpowers",
    revision: 7,
    version: "7.0.1",
    previous_revision: null,
    installed_at: "2026-11-20T00:00:00Z",
    exec_sha256: EXEC,
    consent: EXEC,
    autorun: [HOOK],
    members: MEMBERS,
    hosts: [
      rawListedHost("claude_code"),
      rawListedHost("gemini", {
        host_id: null,
        mode: "skills",
        host_name: null,
        skills: ["brainstorming", "writing-plans"],
        verify: null,
      }),
    ],
    update: null,
    problems: [],
    ...overrides,
  }
}

/** One agent's row in the update plan. */
export function rawUpdateHost(agent: string, overrides: Json = {}): Json {
  return {
    agent,
    host_id: agent === "claude_code" ? "claude" : null,
    mode: "native",
    state: "active",
    to_mode: "native",
    to_state: "active",
    action: "update",
    why_not: null,
    detect: null,
    experts_to_take_over: [],
    experts_ack: null,
    experts_to_give_back: [],
    codex_hooks_need_trust: false,
    skills: null,
    ...overrides,
  }
}

/** The update from 7.0.1 to an approved 7.0.2 with a changed hook. */
export function rawUpdatePlan(overrides: Json = {}): Json {
  return {
    installed: {
      name: "superpowers",
      item_id: "itm_superpowers",
      ref: "obra/superpowers",
      revision: 7,
      version: "7.0.1",
      hosts: {},
      consent: EXEC,
      installed_at: "2026-11-20T00:00:00Z",
    },
    item: {
      id: "itm_superpowers",
      ref: "obra/superpowers",
      kind: "plugin",
      title: { en: "Superpowers" },
      revision: 8,
      version: "7.0.2",
      published_at: "2026-11-21T00:00:00Z",
    },
    item_status: "listed",
    latest: rawRevision(8, "7.0.2", {
      approved: true,
      exec_sha256: NEW_EXEC,
      state_sha256: LATEST_STATE,
    }),
    full: rawRevision(8, "7.0.2", {
      approved: true,
      exec_sha256: NEW_EXEC,
      state_sha256: LATEST_STATE,
    }),
    not_full: null,
    target: 8,
    revision_from: 7,
    version_from: "7.0.1",
    version_to: "7.0.2",
    changed_members: [
      { kind: "skill", name: "brainstorming", change: "changed" },
      { kind: "skill", name: "writing-skills", change: "added" },
    ],
    up_to_date: false,
    needs_consent: true,
    consent_exec: NEW_EXEC,
    autorun: [HOOK],
    snapshot: rawSnapshot(),
    state_sha256: LATEST_STATE,
    hosts: [
      rawUpdateHost("claude_code"),
      rawUpdateHost("gemini", {
        mode: "skills",
        to_mode: "skills",
        experts_ack: EXPERTS_ACK,
        skills: rawOwnedPlan("gemini"),
      }),
    ],
    blocking: [],
    warnings: [],
    limits: {},
    ...overrides,
  }
}
