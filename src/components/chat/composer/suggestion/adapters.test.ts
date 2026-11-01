import { describe, expect, it } from "vitest"
import { parseCodegReferenceUri } from "../reference-uri"
import { referenceToMarkdown } from "../reference-text"

import type { FlatFileEntry } from "@/hooks/use-file-tree"
import type {
  AcpAgentInfo,
  DbConversationSummary,
  GitLogEntry,
} from "@/lib/types"

import {
  agentToSuggestion,
  commitToSuggestion,
  fileToSuggestion,
  sessionToSuggestion,
} from "./adapters"

describe("fileToSuggestion", () => {
  const entry: FlatFileEntry = {
    name: "app.ts",
    relativePath: "src/app.ts",
    kind: "file",
    lowerPath: "src/app.ts",
    lowerName: "app.ts",
  }
  it("maps to a file reference with a joined file:// uri", () => {
    const item = fileToSuggestion(entry, "/repo")
    expect(item.reference).toMatchObject({
      refType: "file",
      id: "src/app.ts",
      label: "app.ts",
      uri: "file:///repo/src/app.ts",
      meta: { fileKind: "file" },
    })
    expect(item.detail).toBe("src/app.ts")
  })
  it("does not double a separator when the root has a trailing slash", () => {
    expect(fileToSuggestion(entry, "/repo/").reference.uri).toBe(
      "file:///repo/src/app.ts"
    )
  })
})

describe("agentToSuggestion", () => {
  it("keeps native identity and exact account through serialization and restore", () => {
    const agent = {
      agent_type: "claude_code",
      name: "Claude Code",
      available: true,
    } as AcpAgentInfo
    const reference = agentToSuggestion(agent, {
      id: "work-account",
      name: "Work",
    }).reference
    expect(reference.meta?.agentType).toBe("claude_code")
    expect(referenceToMarkdown(reference)).toBe(
      "[@Claude Code · Work](codeg://agent/claude_code?account=work-account)"
    )
    expect(
      parseCodegReferenceUri(reference.uri!, "@Claude Code · Work")
    ).toMatchObject({
      id: reference.id,
      label: reference.label,
      meta: { agentType: "claude_code", agentAccountId: "work-account" },
    })
  })
  it("maps to an agent reference with a codeg://agent routing uri", () => {
    const agent = {
      agent_type: "claude_code",
      name: "Claude Code",
      description: "Anthropic CLI",
      available: true,
    } as AcpAgentInfo
    const item = agentToSuggestion(agent)
    expect(item.reference).toMatchObject({
      refType: "agent",
      id: "claude_code",
      label: "Claude Code",
      uri: "codeg://agent/claude_code",
      meta: { agentType: "claude_code", available: true },
    })
  })
})

describe("sessionToSuggestion", () => {
  const base = {
    id: 123,
    agent_type: "codex",
    status: "in_progress",
    git_branch: "main",
  } as DbConversationSummary
  it("encodes the numeric conversation id in the uri (regardless of external_id)", () => {
    const item = sessionToSuggestion({
      ...base,
      title: "Login refactor",
      external_id: "abc123",
    })
    expect(item.reference).toMatchObject({
      refType: "session",
      id: "123",
      label: "Login refactor",
      // Always the internal numeric id now — get_session_info resolves it
      // server-side via the row's bound external_id + agent_type.
      uri: "codeg://session/123",
      // meta.agentType still set, so the @-panel option row shows the agent icon.
      meta: { agentType: "codex", status: "in_progress", branch: "main" },
    })
  })
  it("uses the numeric id even when there is no external_id", () => {
    expect(sessionToSuggestion({ ...base, title: "x" }).reference.uri).toBe(
      "codeg://session/123"
    )
  })
  it("falls back to #id when the title is empty", () => {
    expect(sessionToSuggestion({ ...base, title: null }).reference.label).toBe(
      "#123"
    )
  })
  it("folds inline reference badges in the title to their label text", () => {
    // A title carrying a serialized file badge shows like the sidebar — just the
    // bracket text — in the panel row and on the inserted session badge.
    const item = sessionToSuggestion({
      ...base,
      title: "[README.md](file:///repo/README.md) fix the bug",
    })
    expect(item.reference.label).toBe("README.md fix the bug")
    expect(item.keywords).toBe("README.md fix the bug codex")
  })
  it("falls back to #id when the title is only whitespace", () => {
    expect(sessionToSuggestion({ ...base, title: "   " }).reference.label).toBe(
      "#123"
    )
  })
})

describe("commitToSuggestion", () => {
  it("maps to a commit reference with an encoded repo key", () => {
    const entry = {
      hash: "abc1234",
      full_hash: "abc1234def5678",
      author: "Jane",
      date: "2026-06-10",
      message: "fix login",
      files: [],
      pushed: true,
    } as GitLogEntry
    const item = commitToSuggestion(entry, "/repo with space")
    expect(item.reference).toMatchObject({
      refType: "commit",
      id: "abc1234def5678",
      label: "abc1234",
      uri: "codeg://commit/%2Frepo%20with%20space@abc1234def5678",
      meta: { shortHash: "abc1234", message: "fix login", pushed: true },
    })
  })
})

// skillToSuggestion / expertToSuggestion were retired with the `@` panel's skill
// tab — skills/commands/experts are now inserted via the `/` and `$` triggers
// (see composer/invocation-reference.ts), not adapted for the panel.
