import { describe, expect, it } from "vitest"

import { CODEG_MCP_WORKBENCH_TOOLS } from "@/lib/codeg-mcp-tool"
import { isAgentLikeToolName } from "./tool-kind-classifier"

describe("isAgentLikeToolName", () => {
  it("matches the agent tool exactly", () => {
    expect(isAgentLikeToolName("agent")).toBe(true)
    expect(isAgentLikeToolName("AGENT")).toBe(true)
    expect(isAgentLikeToolName("  agent ")).toBe(true)
  })

  it("matches delegate_to_agent across host naming conventions", () => {
    expect(isAgentLikeToolName("delegate_to_agent")).toBe(true)
    // Claude Code style (current + legacy server names)
    expect(isAgentLikeToolName("mcp__codeg-mcp__delegate_to_agent")).toBe(true)
    expect(isAgentLikeToolName("mcp__codeg-delegate__delegate_to_agent")).toBe(
      true
    )
    expect(isAgentLikeToolName("mcp__codeg__delegate_to_agent")).toBe(true)
    // Codex live ACP style (server/tool)
    expect(isAgentLikeToolName("codeg-mcp/delegate_to_agent")).toBe(true)
    expect(isAgentLikeToolName("codeg-delegate/delegate_to_agent")).toBe(true)
    // Dot- and colon-separated forms other hosts may emit
    expect(isAgentLikeToolName("codeg-delegate.delegate_to_agent")).toBe(true)
    expect(isAgentLikeToolName("codeg-delegate:delegate_to_agent")).toBe(true)
  })

  it("matches the delegation companion tools across host naming conventions", () => {
    for (const tool of ["get_delegation_status", "cancel_delegation"]) {
      // Bare canonical form (live-streaming path, post-inferLiveToolName)
      expect(isAgentLikeToolName(tool)).toBe(true)
      // Claude Code style (current + legacy server names)
      expect(isAgentLikeToolName(`mcp__codeg-mcp__${tool}`)).toBe(true)
      expect(isAgentLikeToolName(`mcp__codeg-delegate__${tool}`)).toBe(true)
      expect(isAgentLikeToolName(`mcp__codeg__${tool}`)).toBe(true)
      // Codex live ACP + dot/colon separated forms
      expect(isAgentLikeToolName(`codeg-mcp/${tool}`)).toBe(true)
      expect(isAgentLikeToolName(`codeg-delegate/${tool}`)).toBe(true)
      expect(isAgentLikeToolName(`codeg-delegate.${tool}`)).toBe(true)
      expect(isAgentLikeToolName(`codeg-delegate:${tool}`)).toBe(true)
    }
  })

  // The classifier keeps its own copy of the workbench list; when
  // `resume_delegation` was added to `CODEG_MCP_WORKBENCH_TOOLS` the copy was
  // not updated once already. Pin the relationship so it can't drift again.
  it("covers every tool that owns a CodegMcpToolCard", () => {
    for (const tool of CODEG_MCP_WORKBENCH_TOOLS) {
      expect(isAgentLikeToolName(tool)).toBe(true)
    }
  })

  it("matches the codeg-mcp workbench companions across host naming conventions", () => {
    // Each owns a CodegMcpToolCard.
    for (const tool of [
      "get_session_info",
      "task_progress",
      "task_complete",
      "create_automation",
      "create_work_task",
      "resume_delegation",
    ]) {
      expect(isAgentLikeToolName(tool)).toBe(true)
      expect(isAgentLikeToolName(`mcp__codeg-mcp__${tool}`)).toBe(true)
      expect(isAgentLikeToolName(`mcp__codeg__${tool}`)).toBe(true)
      expect(isAgentLikeToolName(`codeg-mcp/${tool}`)).toBe(true)
      expect(isAgentLikeToolName(`codeg-mcp.${tool}`)).toBe(true)
      expect(isAgentLikeToolName(`codeg-mcp:${tool}`)).toBe(true)
    }
    // …without dragging the generic task tools along with them.
    expect(isAgentLikeToolName("task")).toBe(false)
    expect(isAgentLikeToolName("taskcreate")).toBe(false)
  })

  it("matches Codex goal tools as standalone card tools", () => {
    expect(isAgentLikeToolName("create_goal")).toBe(true)
    expect(isAgentLikeToolName("update_goal")).toBe(true)
    expect(isAgentLikeToolName("functions.create_goal")).toBe(true)
    expect(isAgentLikeToolName("functions.update_goal")).toBe(true)
  })

  it("matches ask_user_question across host naming conventions", () => {
    expect(isAgentLikeToolName("question")).toBe(true)
    expect(isAgentLikeToolName("ask_user_question")).toBe(true)
    expect(isAgentLikeToolName("mcp__codeg-mcp__ask_user_question")).toBe(true)
    expect(isAgentLikeToolName("codeg-mcp/ask_user_question")).toBe(true)
    expect(isAgentLikeToolName("codeg-mcp.ask_user_question")).toBe(true)
    expect(isAgentLikeToolName("codeg-mcp:ask_user_question")).toBe(true)
  })

  it("matches codex's Plan-mode request_user_input", () => {
    // History keeps the raw name (the live path collapses it to "question"); it
    // owns the AskQuestionResultCard.
    expect(isAgentLikeToolName("request_user_input")).toBe(true)
  })

  it("matches Kimi's native AskUserQuestion history name", () => {
    // The Kimi Code wire.jsonl (and Claude's SDK) record the camel-case tool
    // name, and history passes it raw.
    expect(isAgentLikeToolName("AskUserQuestion")).toBe(true)
    expect(isAgentLikeToolName("askuserquestion")).toBe(true)
  })

  it("matches Antigravity's bare ask_question history name only", () => {
    expect(isAgentLikeToolName("ask_question")).toBe(true)
    // A host-prefixed one is a third-party MCP tool (DeepWiki's, for one).
    expect(isAgentLikeToolName("mcp__deepwiki__ask_question")).toBe(false)
    expect(isAgentLikeToolName("deepwiki/ask_question")).toBe(false)
  })

  it("matches check_user_feedback across host naming conventions", () => {
    expect(isAgentLikeToolName("check_user_feedback")).toBe(true)
    expect(isAgentLikeToolName("mcp__codeg-mcp__check_user_feedback")).toBe(
      true
    )
    expect(isAgentLikeToolName("mcp__codeg__check_user_feedback")).toBe(true)
    expect(isAgentLikeToolName("codeg-mcp/check_user_feedback")).toBe(true)
    expect(isAgentLikeToolName("codeg-mcp.check_user_feedback")).toBe(true)
    expect(isAgentLikeToolName("codeg-mcp:check_user_feedback")).toBe(true)
  })

  it("does not match other tools", () => {
    expect(isAgentLikeToolName("task")).toBe(false)
    expect(isAgentLikeToolName("subagent")).toBe(false)
    expect(isAgentLikeToolName("")).toBe(false)
    // No separator before the suffix — must not match.
    expect(isAgentLikeToolName("xdelegate_to_agent")).toBe(false)
    expect(isAgentLikeToolName("xget_delegation_status")).toBe(false)
    expect(isAgentLikeToolName("xcancel_delegation")).toBe(false)
    expect(isAgentLikeToolName("xask_user_question")).toBe(false)
    expect(isAgentLikeToolName("xcheck_user_feedback")).toBe(false)
  })
})
