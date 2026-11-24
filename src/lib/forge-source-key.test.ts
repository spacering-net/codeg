import { describe, expect, it } from "vitest"
import { buildForgeSourceKey, normalizeForgeRepo } from "./forge-source-key"
import { chipStateForLink } from "./forge-task-chip"
import type { ForgeTaskLink } from "./types"

describe("buildForgeSourceKey", () => {
  it("mirrors the backend normalizer (lowercase host+repo, .git stripped)", () => {
    // Backend truth table: src-tauri/src/forge/mod.rs source_key tests —
    // these MUST stay in lockstep or chips silently stop matching tasks.
    expect(
      buildForgeSourceKey({
        provider: "github",
        serverHost: "GitHub.com",
        ownerRepo: "Acme/App",
        kind: "issue",
        number: 123,
      })
    ).toBe("github:github.com:acme/app:issue:123")
    expect(
      buildForgeSourceKey({
        provider: "gitlab",
        serverHost: "gitlab.corp.com",
        ownerRepo: "/Group/Sub/Proj.git",
        kind: "pr",
        number: 45,
      })
    ).toBe("gitlab:gitlab.corp.com:group/sub/proj:pr:45")
  })

  it("normalizes repos the way remotes spell them", () => {
    expect(normalizeForgeRepo("Acme/App.git")).toBe("acme/app")
    expect(normalizeForgeRepo("  /a/b/  ")).toBe("a/b")
  })
})

describe("chipStateForLink", () => {
  const link = (status: ForgeTaskLink["status"]): ForgeTaskLink => ({
    source_key: "github:github.com:a/b:issue:1",
    task_id: 7,
    status,
    verdict: null,
    updated_at: "2026-08-17T00:00:00Z",
  })

  it("derives the row's three states", () => {
    expect(chipStateForLink(null)).toBe("none")
    expect(chipStateForLink(undefined)).toBe("none")
    for (const s of [
      "todo",
      "queued",
      "preparing",
      "running",
      "awaiting_input",
      "review",
      "merging",
    ] as const) {
      expect(chipStateForLink(link(s))).toBe("active")
    }
    for (const s of ["done", "failed", "canceled"] as const) {
      expect(chipStateForLink(link(s))).toBe("terminal")
    }
  })
})
