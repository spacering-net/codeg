import { describe, expect, it } from "vitest"

import { CODEG_MCP_WORKBENCH_TOOLS } from "@/lib/codeg-mcp-tool"
import {
  classifyToolKind,
  isAgentLikeToolName,
  TOOL_KIND_ORDER,
  type ToolKindLabel,
} from "./tool-kind-classifier"

describe("classifyToolKind", () => {
  it.each([
    ["grep", "search"],
    ["GLOB", "search"],
    ["list_files", "search"],
    // pi's built-in set is bash/edit/find/grep/ls/powershell/read/write; `ls`
    // and `powershell` used to fall through to "other".
    ["find", "search"],
    ["ls", "search"],
    ["powershell", "command"],
    ["bash", "command"],
    ["execute_command", "command"],
    ["read", "read"],
    ["Read File", "read"],
    ["view", "read"],
    ["edit", "edit"],
    ["NotebookEdit", "edit"],
    ["replace_in_file", "edit"],
    ["webfetch", "fetch"],
    ["browser_action", "fetch"],
    ["think", "think"],
    ["EnterPlanMode", "think"],
    ["TodoWrite", "todo"],
    ["update_todo_list", "todo"],
    ["task", "task"],
    ["new_task", "task"],
    ["skill", "task"],
    ["memory_recall", "memory"],
    ["MEMORY_RECALL", "memory"],
    ["my_custom_tool", "other"],
    ["", "other"],
  ] as const)("classifies %s as %s", (name, expected) => {
    expect(classifyToolKind(name)).toBe(expected as ToolKindLabel)
  })

  it("normalizes whitespace and case", () => {
    expect(classifyToolKind("  Grep  ")).toBe("search")
    expect(classifyToolKind("BASH")).toBe("command")
  })
})

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
  // not updated, so the resume card spent its life wrapped in a spurious
  // "工具 ×1" group shell. Pin the relationship so it can't drift again.
  it("covers every tool that owns a CodegMcpToolCard", () => {
    for (const tool of CODEG_MCP_WORKBENCH_TOOLS) {
      expect(isAgentLikeToolName(tool)).toBe(true)
    }
  })

  it("matches the codeg-mcp workbench companions across host naming conventions", () => {
    // Each owns a CodegMcpToolCard, so it breaks the tool-group run and renders
    // standalone rather than folding into a "工具 ×N" tally.
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
    // owns the AskQuestionResultCard, so it must render standalone, not folded.
    expect(isAgentLikeToolName("request_user_input")).toBe(true)
  })

  it("matches Kimi's native AskUserQuestion history name", () => {
    // The Kimi Code wire.jsonl (and Claude's SDK) record the camel-case tool
    // name; history passes it raw, so without this the answered capsule was
    // wrapped inside a generic tool-group (the reported bug).
    expect(isAgentLikeToolName("AskUserQuestion")).toBe(true)
    expect(isAgentLikeToolName("askuserquestion")).toBe(true)
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

describe("TOOL_KIND_ORDER", () => {
  it("includes every label exactly once", () => {
    const expected: ToolKindLabel[] = [
      "search",
      "command",
      "read",
      "memory",
      "edit",
      "fetch",
      "think",
      "todo",
      "task",
      "other",
    ]
    expect([...TOOL_KIND_ORDER].sort()).toEqual([...expected].sort())
    expect(new Set(TOOL_KIND_ORDER).size).toBe(TOOL_KIND_ORDER.length)
  })
})
