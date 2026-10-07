import { describe, expect, it } from "vitest"

import {
  aliasToolInputKeys,
  claudeCodeMarksSubagent,
  codexMarksPlanReview,
  extractClaudeCodeMetaTitle,
  extractClaudeCodeSkillName,
  inferLiveToolName,
  normalizeToolName,
  toolCallMovedToBackground,
} from "./tool-call-normalization"

describe("aliasToolInputKeys", () => {
  it("fills the canonical names OpenCode spells in camelCase", () => {
    // The live wire shape of an OpenCode `write` / `edit` call: its ACP adapter
    // forwards the tool's own camelCase arguments, so the Write card found no
    // `file_path` and rendered "unknown" under a header naming the file.
    expect(
      aliasToolInputKeys({
        filePath: "src/app/minimal/page.tsx",
        content: "export const A = 1\n",
      })
    ).toEqual({
      filePath: "src/app/minimal/page.tsx",
      file_path: "src/app/minimal/page.tsx",
      content: "export const A = 1\n",
    })

    expect(
      aliasToolInputKeys({
        filePath: "src/app.ts",
        oldString: "a",
        newString: "b",
        replaceAll: true,
      })
    ).toMatchObject({
      file_path: "src/app.ts",
      old_string: "a",
      new_string: "b",
      replace_all: true,
    })
  })

  it("never overrides what the agent actually sent", () => {
    const input = { filePath: "camel.ts", file_path: "snake.ts" }
    expect(aliasToolInputKeys(input)).toBe(input)
  })

  it("is a no-op (same reference) on already-canonical and unrelated input", () => {
    // History is normalized in Rust, and snake_case agents never trip this —
    // returning the same object keeps `useMemo` consumers from re-rendering.
    const canonical = { file_path: "a.ts", old_string: "x", new_string: "y" }
    expect(aliasToolInputKeys(canonical)).toBe(canonical)

    const unrelated = { command: "pnpm test" }
    expect(aliasToolInputKeys(unrelated)).toBe(unrelated)

    expect(aliasToolInputKeys(null)).toBeNull()
  })

  it("ignores an alias whose value is null", () => {
    const input = { filePath: null, content: "x" }
    expect(aliasToolInputKeys(input)).toBe(input)
  })
})

describe("inferLiveToolName meta.claudeCode.toolName override", () => {
  it("returns memory_recall for synthesized recall events without rawInput", () => {
    // Mirrors what claude-agent-acp >=0.37 emits for memory recall:
    // title carries the human-readable count, kind borrows the file-read
    // category, rawInput is null. Only the meta field knows the real name.
    expect(
      inferLiveToolName({
        title: "Recalled 3 memories",
        kind: "read",
        rawInput: null,
        meta: { claudeCode: { toolName: "memory_recall" } },
      })
    ).toBe("memory_recall")

    expect(
      inferLiveToolName({
        title: "Recalled synthesized memory",
        kind: "read",
        rawInput: null,
        meta: { claudeCode: { toolName: "memory_recall" } },
      })
    ).toBe("memory_recall")
  })

  it("falls back to title-based inference when no meta is provided", () => {
    // Pre-0.37 traffic / non-Claude agents have no meta.claudeCode.toolName.
    // The legacy paths must keep working.
    expect(
      inferLiveToolName({
        title: "Recalled 3 memories",
        kind: "read",
        rawInput: null,
      })
    ).not.toBe("memory_recall")
  })

  it("resolves delegate_to_agent from broker delegation meta on identity-less wires", () => {
    // Cursor announces MCP calls as the literal "MCP: tool" with an empty
    // rawInput and never resends either — the broker's
    // meta["codeg.delegation"] write is the only live identity signal.
    expect(
      inferLiveToolName({
        title: "MCP: tool",
        kind: "other",
        rawInput: "{}",
        meta: {
          "codeg.delegation": { status: "running", child_conversation_id: 42 },
        },
      })
    ).toBe("delegate_to_agent")
  })

  it("keeps input-shape priority for calls without delegation meta", () => {
    // A generic "MCP: tool" call WITHOUT the broker meta must stay generic —
    // the delegation resolution is scoped to the codeg-minted marker.
    expect(
      inferLiveToolName({
        title: "MCP: tool",
        kind: "other",
        rawInput: "{}",
        meta: null,
      })
    ).not.toBe("delegate_to_agent")
  })

  it("returns canonical lower-case 'agent' for the SDK Agent tool before rawInput streams in", () => {
    // claude-agent-acp reports the Agent/Task tool as `Agent` (capitalised) and
    // often emits the initial ToolCall before `rawInput` (which carries
    // `subagent_type`) is available. The metaToolName fallback must return the
    // canonical lower-case `agent` so the live agent-card nesting check
    // (`getToolName(...) === "agent"`) recognises it and child tool calls nest
    // under the card. A capitalised `Agent` slipped past that check, leaving the
    // children un-nested and the card stuck on its placeholder title.
    expect(
      inferLiveToolName({
        title: "Explore the codebase",
        kind: "other",
        rawInput: null,
        meta: { claudeCode: { toolName: "Agent" } },
      })
    ).toBe("agent")
  })

  it("keeps memory_recall intact when lower-casing the metaToolName fallback", () => {
    // Guard: the lower-case fix must NOT route metaToolName through
    // `normalizeToolName`, whose live-title heuristic rewrites `memory_recall`
    // to `memory_re`.
    expect(
      inferLiveToolName({
        title: "Recalled 3 memories",
        kind: "read",
        rawInput: null,
        meta: { claudeCode: { toolName: "memory_recall" } },
      })
    ).toBe("memory_recall")
  })

  it("preserves sub-agent detection when rawInput carries subagent_type", () => {
    // Regression guard: meta.claudeCode.toolName="Task" must NOT override
    // input-shape detection. Otherwise Claude Code's Task tool stops
    // routing into the AgentToolCallPart card and child tool calls no
    // longer nest under their parent.
    expect(
      inferLiveToolName({
        title: "Implement feature X",
        kind: "other",
        rawInput: JSON.stringify({
          subagent_type: "general-purpose",
          prompt: "Do the thing",
        }),
        meta: { claudeCode: { toolName: "Task" } },
      })
    ).toBe("agent")
  })

  it("classifies via the authoritative subagent marker before any input shape (≥0.63)", () => {
    // Frame 1 of an Agent/Task launch: rawInput hasn't streamed, the meta
    // toolName may be the legacy "Task" — the `subagent: true` marker alone
    // must classify. (claude-agent-acp ≥0.63, _meta.claudeCode.subagent.)
    expect(
      inferLiveToolName({
        title: "Implement feature X",
        kind: "other",
        rawInput: null,
        meta: { claudeCode: { toolName: "Task", subagent: true } },
      })
    ).toBe("agent")
    // The marker is authoritative even over a misleading input shape (a
    // command-bearing payload would otherwise classify as bash).
    expect(
      inferLiveToolName({
        title: "Run checks",
        kind: "other",
        rawInput: JSON.stringify({ command: "pnpm test" }),
        meta: { claudeCode: { toolName: "Agent", subagent: true } },
      })
    ).toBe("agent")
    // Strict `=== true`: any other shape leaves classification untouched.
    expect(
      inferLiveToolName({
        title: "bash",
        kind: "execute",
        rawInput: JSON.stringify({ command: "ls" }),
        meta: { claudeCode: { toolName: "Bash", subagent: "yes" } },
      })
    ).toBe("bash")
  })

  it("claudeCodeMarksSubagent / extractClaudeCodeMetaTitle guard their shapes", () => {
    expect(claudeCodeMarksSubagent({ claudeCode: { subagent: true } })).toBe(
      true
    )
    expect(claudeCodeMarksSubagent({ claudeCode: { subagent: false } })).toBe(
      false
    )
    expect(claudeCodeMarksSubagent({ claudeCode: {} })).toBe(false)
    expect(claudeCodeMarksSubagent(null)).toBe(false)
    expect(claudeCodeMarksSubagent({ claudeCode: "subagent" })).toBe(false)

    expect(
      extractClaudeCodeMetaTitle({
        claudeCode: { title: "Show current diff" },
      })
    ).toBe("Show current diff")
    expect(extractClaudeCodeMetaTitle({ claudeCode: { title: "   " } })).toBe(
      null
    )
    expect(extractClaudeCodeMetaTitle({ claudeCode: { title: 42 } })).toBe(null)
    expect(extractClaudeCodeMetaTitle({ claudeCode: {} })).toBe(null)
    expect(extractClaudeCodeMetaTitle(undefined)).toBe(null)
  })

  it("extractClaudeCodeSkillName reads the #986 skill meta and guards its shape", () => {
    // claude-agent-acp ≥0.67 stamps Skill tool calls with
    // `_meta.claudeCode.skill` (+ optional `skillPath`); the name is the
    // authoritative title source, present before `rawInput` streams.
    expect(
      extractClaudeCodeSkillName({
        claudeCode: {
          toolName: "Skill",
          skill: "commit-helper",
          skillPath: "/repo/.claude/skills/commit-helper/SKILL.md",
        },
      })
    ).toBe("commit-helper")
    expect(extractClaudeCodeSkillName({ claudeCode: { skill: "  " } })).toBe(
      null
    )
    expect(extractClaudeCodeSkillName({ claudeCode: { skill: 7 } })).toBe(null)
    expect(extractClaudeCodeSkillName({ claudeCode: {} })).toBe(null)
    expect(extractClaudeCodeSkillName({ skill: "top-level" })).toBe(null)
    expect(extractClaudeCodeSkillName(null)).toBe(null)
  })

  it("resolves delegation companion tools from meta over the input-shape heuristic", () => {
    // Regression guard for Task B: these companion tools must resolve from the
    // authoritative meta.claudeCode.toolName (the raw mcp__ name), not from their
    // input shape. get_delegation_status takes `{ task_ids }` and cancel_delegation
    // takes `{ task_id }` — the latter would otherwise be classified by
    // inferFromInput as the generic "task" tool (rendered as "任务" with no
    // detail). meta must win.
    expect(
      inferLiveToolName({
        title: "mcp__codeg-delegate__get_delegation_status",
        kind: "other",
        rawInput: JSON.stringify({ task_ids: ["t1"], wait_ms: 1000 }),
        meta: {
          claudeCode: {
            toolName: "mcp__codeg-delegate__get_delegation_status",
          },
        },
      })
    ).toBe("get_delegation_status")

    expect(
      inferLiveToolName({
        title: "mcp__codeg-delegate__cancel_delegation",
        kind: "other",
        rawInput: JSON.stringify({ task_id: "t1" }),
        meta: {
          claudeCode: { toolName: "mcp__codeg-delegate__cancel_delegation" },
        },
      })
    ).toBe("cancel_delegation")

    expect(
      inferLiveToolName({
        title: "mcp__codeg-delegate__delegate_to_agent",
        kind: "other",
        rawInput: JSON.stringify({ agent_type: "codex", task: "do it" }),
        meta: {
          claudeCode: { toolName: "mcp__codeg-delegate__delegate_to_agent" },
        },
      })
    ).toBe("delegate_to_agent")
  })

  it("still classifies a {task_id} tool as task when no Claude Code meta is present", () => {
    // Non-Claude agents (no meta.claudeCode.toolName) keep the legacy
    // input-shape behavior — the fix is meta-driven, not a removal of the
    // task_id heuristic.
    expect(
      inferLiveToolName({
        title: "Some task",
        kind: "other",
        rawInput: JSON.stringify({ task_id: "t1" }),
        meta: null,
      })
    ).toBe("task")
  })

  it("resolves Grok companion tools from the unwrapped title over the input shape", () => {
    // Grok sets no claudeCode meta; its backend unwraps the `use_tool` envelope
    // so the title is the raw `<server>__<tool>` name. cancel_delegation's
    // {task_id} input would otherwise be misread as the generic "task" tool —
    // the title-companion priority must win.
    expect(
      inferLiveToolName({
        title: "codeg-mcp__cancel_delegation",
        kind: "other",
        rawInput: JSON.stringify({ task_id: "t1" }),
        meta: { "x.ai/tool": { name: "use_tool" } },
      })
    ).toBe("cancel_delegation")
    // Siblings stay correct too.
    expect(
      inferLiveToolName({
        title: "codeg-mcp__get_delegation_status",
        kind: "other",
        rawInput: JSON.stringify({ task_ids: ["t1"] }),
        meta: { "x.ai/tool": { name: "use_tool" } },
      })
    ).toBe("get_delegation_status")
    expect(
      inferLiveToolName({
        title: "codeg-mcp__delegate_to_agent",
        kind: "other",
        rawInput: JSON.stringify({ agent_type: "codex", task: "go" }),
        meta: { "x.ai/tool": { name: "use_tool" } },
      })
    ).toBe("delegate_to_agent")
  })

  it("ignores meta when claudeCode is missing or malformed", () => {
    expect(
      inferLiveToolName({
        title: "Recalled 3 memories",
        kind: "read",
        rawInput: null,
        meta: null,
      })
    ).not.toBe("memory_recall")

    expect(
      inferLiveToolName({
        title: "Recalled 3 memories",
        kind: "read",
        rawInput: null,
        meta: { somethingElse: { toolName: "memory_recall" } },
      })
    ).not.toBe("memory_recall")

    expect(
      inferLiveToolName({
        title: "Recalled 3 memories",
        kind: "read",
        rawInput: null,
        meta: { claudeCode: { toolName: "   " } },
      })
    ).not.toBe("memory_recall")
  })
})

describe("inferLiveToolName query-bearing MCP calls", () => {
  it("keeps an explicit OpenCode MCP tool title", () => {
    expect(
      inferLiveToolName({
        title: "codegraph_explore",
        kind: "other",
        rawInput: JSON.stringify({ query: "find the auth flow" }),
      })
    ).toBe("codegraph_explore")
  })

  it("still classifies a query as websearch when the wire names websearch", () => {
    expect(
      inferLiveToolName({
        title: "web_search",
        kind: "other",
        rawInput: JSON.stringify({ query: "Codeg" }),
      })
    ).toBe("websearch")

    expect(
      inferLiveToolName({
        title: "Search",
        kind: "websearch",
        rawInput: JSON.stringify({ query: "Codeg" }),
      })
    ).toBe("websearch")
  })

  it("recognizes Codex web-search action frames", () => {
    expect(
      inferLiveToolName({
        title: "Open page: https://example.com",
        kind: "search",
        rawInput: JSON.stringify({
          query: "Codeg",
          action: { type: "openPage", url: "https://example.com" },
        }),
      })
    ).toBe("websearch")

    // session/load replay omits the `type` marker, but keeps the action title
    // and payload. `kind: "search"` must not be enough on its own because
    // local fuzzy-file searches use the same ACP kind.
    expect(
      inferLiveToolName({
        title: "Find in page for 'ACP' in https://example.com",
        kind: "search",
        rawInput: JSON.stringify({
          query: "Codeg",
          action: {
            type: "findInPage",
            pattern: "ACP",
            url: "https://example.com",
          },
        }),
      })
    ).toBe("websearch")

    // The marker is also sufficient when a title is too generic to identify
    // the action on its own.
    expect(
      inferLiveToolName({
        title: "Search",
        kind: "other",
        rawInput: JSON.stringify({ type: "webSearch", query: "Codeg" }),
      })
    ).toBe("websearch")
  })

  it("recognizes Gemini web-search frames by their title", () => {
    // gemini's `google_web_search` reports `kind: "search"` — the same kind as
    // its glob and grep — so the title is the only "web" signal. The backend
    // synthesizes `{query}` from that title because gemini sends no rawInput
    // at all (`gemini_synthesize_tool_input`).
    expect(
      inferLiveToolName({
        title: 'Searching the web for: "ACP protocol"',
        kind: "search",
        rawInput: JSON.stringify({ query: "ACP protocol" }),
      })
    ).toBe("websearch")

    // Still not enough on its own: the phrase has to START the title, so a
    // tool merely mentioning it stays unclassified.
    expect(
      inferLiveToolName({
        title: 'Explain searching the web for: "x"',
        kind: "search",
        rawInput: JSON.stringify({ query: "x" }),
      })
    ).not.toBe("websearch")
  })

  it("does not infer websearch from a query field alone", () => {
    expect(
      inferLiveToolName({
        title: "MCP: tool",
        kind: "other",
        rawInput: JSON.stringify({ query: "find usages" }),
      })
    ).not.toBe("websearch")

    expect(
      inferLiveToolName({
        title: "Search for 'find usages'",
        kind: "search",
        rawInput: JSON.stringify({ query: "find usages" }),
      })
    ).toBe("grep")
  })
})

describe("normalizeToolName collapses delegate_to_agent across hosts", () => {
  // The codeg multi-agent delegation MCP tool is named the same across hosts
  // (`delegate_to_agent`) but each host serializes the server prefix
  // differently: Claude Code uses `mcp__<server>__`, Codex live ACP uses
  // `<server>/`, others use `.` or `:`. All forms must collapse to the
  // canonical name so the renderer routes them into DelegatedSubThread.
  it.each([
    "delegate_to_agent",
    "mcp__codeg-mcp__delegate_to_agent",
    "mcp__codeg-delegate__delegate_to_agent",
    "mcp__codeg__delegate_to_agent",
    "codeg-mcp/delegate_to_agent",
    "codeg-delegate/delegate_to_agent",
    "codeg-delegate.delegate_to_agent",
    "codeg-delegate:delegate_to_agent",
    "codeg_delegate__delegate_to_agent",
  ])("%s -> delegate_to_agent", (input) => {
    expect(normalizeToolName(input)).toBe("delegate_to_agent")
  })

  it("does not match suffixes without a separator", () => {
    expect(normalizeToolName("xdelegate_to_agent")).not.toBe(
      "delegate_to_agent"
    )
  })
})

describe("normalizeToolName collapses delegation companion tools across hosts", () => {
  it.each([
    "get_delegation_status",
    "mcp__codeg-mcp__get_delegation_status",
    "mcp__codeg-delegate__get_delegation_status",
    "mcp__codeg__get_delegation_status",
    "codeg-mcp/get_delegation_status",
    "codeg-delegate/get_delegation_status",
    "codeg-delegate.get_delegation_status",
    "codeg-delegate:get_delegation_status",
  ])("%s -> get_delegation_status", (input) => {
    expect(normalizeToolName(input)).toBe("get_delegation_status")
  })

  it.each([
    "cancel_delegation",
    "mcp__codeg-mcp__cancel_delegation",
    "mcp__codeg-delegate__cancel_delegation",
    "mcp__codeg__cancel_delegation",
    "codeg-mcp/cancel_delegation",
    "codeg-delegate/cancel_delegation",
    "codeg-delegate.cancel_delegation",
    "codeg-delegate:cancel_delegation",
  ])("%s -> cancel_delegation", (input) => {
    expect(normalizeToolName(input)).toBe("cancel_delegation")
  })

  it("does not match suffixes without a separator", () => {
    expect(normalizeToolName("xget_delegation_status")).not.toBe(
      "get_delegation_status"
    )
    expect(normalizeToolName("xcancel_delegation")).not.toBe(
      "cancel_delegation"
    )
  })
})

describe("normalizeToolName collapses ask_user_question across hosts", () => {
  it.each([
    "question",
    "ask_user_question",
    "askuserquestion",
    "mcp__codeg-mcp__ask_user_question",
    "codeg-mcp/ask_user_question",
    "codeg-mcp.ask_user_question",
    "codeg-mcp:ask_user_question",
  ])("%s -> question", (input) => {
    expect(normalizeToolName(input)).toBe("question")
  })

  it("does not match a suffix without a separator", () => {
    expect(normalizeToolName("xask_user_question")).not.toBe("question")
  })
})

describe("normalizeToolName collapses check_user_feedback across hosts", () => {
  it.each([
    "check_user_feedback",
    "mcp__codeg-mcp__check_user_feedback",
    "mcp__codeg__check_user_feedback",
    "codeg-mcp/check_user_feedback",
    "codeg-mcp.check_user_feedback",
    "codeg-mcp:check_user_feedback",
  ])("%s -> check_user_feedback", (input) => {
    expect(normalizeToolName(input)).toBe("check_user_feedback")
  })

  it("does not match a suffix without a separator", () => {
    expect(normalizeToolName("xcheck_user_feedback")).not.toBe(
      "check_user_feedback"
    )
  })
})

describe("normalizeToolName collapses Codex goal tools across wrappers", () => {
  it.each([
    ["create_goal", "create_goal"],
    ["functions.create_goal", "create_goal"],
    ["mcp__codeg__create_goal", "create_goal"],
    ["Goal updated (active): 分析 README 文件", "create_goal"],
    ["update_goal", "update_goal"],
    ["functions.update_goal", "update_goal"],
    ["mcp__codeg__update_goal", "update_goal"],
    ["Goal updated (complete): 分析 README 文件", "update_goal"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeToolName(input)).toBe(expected)
  })

  it("infers live Codex goal updates from ACP titles", () => {
    expect(
      inferLiveToolName({
        title: "Goal updated (active): 分析 README 文件",
        kind: "other",
        rawInput: JSON.stringify({ objective: "分析 README 文件" }),
      })
    ).toBe("create_goal")

    expect(
      inferLiveToolName({
        title: "Goal updated (complete): 分析 README 文件",
        kind: "other",
        rawInput: JSON.stringify({ status: "complete" }),
      })
    ).toBe("update_goal")
  })
})

describe("inferLiveToolName codex collab detection", () => {
  const collabRaw = JSON.stringify({
    prompt: "run pnpm build",
    senderThreadId: "t1",
    receiverThreadIds: ["t2"],
    agentsStates: [],
    status: "in_progress",
  })

  it("routes collab tool calls by rawInput shape regardless of title", () => {
    // codex-acp 1.0.1 #223: the live title is the bare collab op; detection is
    // by the inter-agent rawInput shape, so any of spawn/wait/close collapses to
    // the dedicated collab card — overriding the spawn_agent→"agent" /
    // wait_agent→"task" title aliases.
    for (const title of ["spawn_agent", "wait_agent", "close_agent"]) {
      expect(
        inferLiveToolName({ title, kind: "other", rawInput: collabRaw })
      ).toBe("collab_agent")
    }
  })

  it("does NOT treat the spawn_agent function_call args as collab", () => {
    // Same title, but the non-collab input (no sender/receiver/agentsStates)
    // must fall through to the title alias instead of the collab card.
    expect(
      inferLiveToolName({
        title: "spawn_agent",
        kind: "other",
        rawInput: JSON.stringify({ agent_type: "worker", message: "go" }),
      })
    ).toBe("agent")
  })
})

describe("normalizeToolName Grok terminal tool", () => {
  it("aliases Grok's run_terminal_command to bash", () => {
    // Grok Build (xAI) reports its terminal tool as `run_terminal_command`
    // (`_meta["x.ai/tool"].name`), which the history parser stores verbatim.
    // Without the alias the reload path would miss the "bash" classification
    // the live path infers from `rawInput.command`, rendering the command card
    // via the generic tool shell (raw ANSI, no terminal title) instead of the
    // Terminal card.
    expect(normalizeToolName("run_terminal_command")).toBe("bash")
  })
})

describe("normalizeToolName Windows shell tool", () => {
  it("aliases PowerShell to bash in every spelling the parsers store", () => {
    // Claude Code's CLI runs commands through a `PowerShell` tool when Windows
    // has no Git Bash (claude-agent-acp ≥0.79.0 gives it Bash's `kind:
    // "execute"` + command title); pi uses the lower-case name for the same
    // thing. Both history parsers keep the raw name, so without the alias the
    // reload path rendered a terminal icon over a raw-JSON dump — the card body
    // dispatches on the normalized name.
    expect(normalizeToolName("PowerShell")).toBe("bash")
    expect(normalizeToolName("powershell")).toBe("bash")
  })

  it("does not sweep in unrelated names that merely contain 'shell'", () => {
    expect(normalizeToolName("powershell_profile_lint")).toBe(
      "powershell_profile_lint"
    )
  })

  it("agrees with the live path, which classifies on the input shape", () => {
    // claude-agent-acp ≥0.79.0 streams `rawInput` for PowerShell exactly as it
    // does for Bash, so the live and reload paths must land on the same name.
    expect(
      inferLiveToolName({
        title: "Get-ChildItem -Recurse",
        kind: "execute",
        rawInput: JSON.stringify({
          command: "Get-ChildItem -Recurse",
          description: "List files",
        }),
        meta: { claudeCode: { toolName: "PowerShell", title: "List files" } },
      })
    ).toBe("bash")
    // …including before `rawInput` streams, when the meta name is all there is.
    expect(
      normalizeToolName(
        inferLiveToolName({
          title: "PowerShell",
          kind: "execute",
          rawInput: null,
          meta: { claudeCode: { toolName: "PowerShell" } },
        })
      )
    ).toBe("bash")
  })
})

describe("Antigravity terminal tool", () => {
  it("aliases the history parser's run_command to bash", () => {
    // `parsers/antigravity.rs` stores the trajectory's own tool name.
    expect(normalizeToolName("run_command")).toBe("bash")
  })

  it("classifies the live exec call by its input shape, not its title", () => {
    // The live title IS the command — `tools.py::extract_tool_display_title`
    // returns the CommandLine for exec tools "so IDEs render the command
    // inside the terminal box". `byTitle` therefore resolves before `byKind`
    // and named the tool "pnpm build", stranding it on the generic tool shell
    // with the `{combinedOutput, exitCode, formatted_output, …}` rawOutput
    // dumped as a JSON tree. Only the input shape identifies it.
    expect(
      inferLiveToolName({
        title: "pnpm build",
        kind: "execute",
        rawInput: JSON.stringify({
          command_line: "pnpm build",
          working_dir: "/Users/x/work/my-app",
        }),
      })
    ).toBe("bash")
  })

  it("classifies the PascalCase envelope a permission frame carries", () => {
    // `_request_permission` forwards the MODEL's own argument envelope
    // verbatim, which spells the same two arguments `CommandLine` / `Cwd`.
    // That is also what the trajectory stores, so the historical card resolves
    // through this branch too when the tool name is missing.
    expect(
      inferLiveToolName({
        title: "pnpm build",
        kind: "execute",
        rawInput: JSON.stringify({
          CommandLine: "pnpm build",
          Cwd: "/Users/x/work/my-app",
          WaitMsBeforeAsync: 10000,
          toolAction: "Running pnpm build",
        }),
      })
    ).toBe("bash")
  })
})

describe("Antigravity MCP dispatch naming", () => {
  it("collapses the <server>_<tool> name both paths now emit", () => {
    // Antigravity routes EVERY MCP call through the `call_mcp_tool` sentinel
    // and re-presents it as `<server>_<tool>`
    // (`tools.py::unwrap_mcp_tool_call`); `parsers/antigravity.rs` performs the
    // same rewrite so history and live resolve identically. Pinned here
    // because that naming is now load-bearing for the delegation cards.
    expect(normalizeToolName("codeg-mcp_delegate_to_agent")).toBe(
      "delegate_to_agent"
    )
    expect(normalizeToolName("codeg-mcp_get_delegation_status")).toBe(
      "get_delegation_status"
    )
    expect(normalizeToolName("codeg-mcp_ask_user_question")).toBe("question")
    expect(normalizeToolName("codeg-mcp_task_progress")).toBe("task_progress")
  })
})

describe("Grok spawn_subagent routes to the Agent card", () => {
  it("aliases the raw spawn_subagent name to agent", () => {
    // The freeform `\bagent\b` matcher can NOT catch it — "subagent" has no
    // word boundary before "agent" — so without the exact alias any path
    // where only the raw name survives renders a generic card.
    expect(normalizeToolName("spawn_subagent")).toBe("agent")
  })

  it("classifies the live frame-1 tool_call by its input shape", () => {
    // The exact first frame captured from a real grok session (019f9432):
    // rawInput carries the standard `{description, prompt, subagent_type}`.
    expect(
      inferLiveToolName({
        title: "spawn_subagent",
        kind: "other",
        rawInput: JSON.stringify({
          description: "Explore test pages patterns",
          prompt: "Explore this Next.js app codebase…",
          subagent_type: "explore",
          capability_mode: "read-only",
        }),
        meta: {
          "x.ai/tool": {
            name: "spawn_subagent",
            kind: "task",
            label: "Subagent",
          },
        },
      })
    ).toBe("agent")
  })

  it("still resolves via x.ai/tool.name when rawInput is absent", () => {
    expect(
      inferLiveToolName({
        title: "Explore test pages patterns",
        kind: "other",
        rawInput: null,
        meta: { "x.ai/tool": { name: "spawn_subagent", kind: "task" } },
      })
    ).toBe("agent")
  })
})

describe("inferLiveToolName cursor task and MCP shapes", () => {
  it("routes cursor's task tool to the Agent card from the bare _toolName snapshot", () => {
    // Cursor announces the tool_call before its args stream in, so the live
    // rawInput is often just the identity stamp — and with no args the wire
    // title is the placeholder "Task: Subagent task", which would otherwise
    // resolve to the generic task card via the freeform `^task` matcher.
    expect(
      inferLiveToolName({
        title: "Task: Subagent task",
        kind: "other",
        rawInput: JSON.stringify({ _toolName: "task" }),
      })
    ).toBe("agent")
  })

  it("routes a fully-populated cursor task payload to the Agent card", () => {
    expect(
      inferLiveToolName({
        title: "Task: run the build",
        kind: "other",
        rawInput: JSON.stringify({
          _toolName: "task",
          prompt: "Run pnpm build and report back.",
          description: "run the build",
          subagentType: { case: "generalPurpose", value: {} },
        }),
      })
    ).toBe("agent")
  })

  it("resolves cursor MCP calls to <provider>__<tool> instead of bash", () => {
    // Cursor's mcpToolCall rawInput carries an `args` object — without the
    // provider/tool resolution the `args` key heuristic would misclassify
    // the call as a terminal command.
    expect(
      inferLiveToolName({
        title: "codeg-mcp: delegate_to_agent",
        kind: "other",
        rawInput: JSON.stringify({
          providerIdentifier: "codeg-mcp",
          toolName: "delegate_to_agent",
          args: { agent_type: "codex", task: "run build" },
        }),
      })
    ).toBe("delegate_to_agent")
    expect(
      inferLiveToolName({
        title: "srv: custom_tool",
        kind: "other",
        rawInput: JSON.stringify({
          providerIdentifier: "srv",
          toolName: "custom_tool",
          args: { command: "echo hi" },
        }),
      })
    ).not.toBe("bash")
  })

  it("collapses other cursor _toolName hints to their canonical snake_case names", () => {
    expect(
      inferLiveToolName({
        title: "Create Plan: refactor",
        kind: "other",
        rawInput: JSON.stringify({ _toolName: "createPlan", name: "refactor" }),
      })
    ).toBe("create_plan")
  })
})

describe("inferLiveToolName Grok plan-mode via x.ai/tool.kind", () => {
  it("resolves enter_plan_mode from x.ai/tool.kind despite the mutating title", () => {
    // Grok's live tool_call title drifts `enter_plan_mode` → "Plan: Enter" →
    // "Plan mode entered" while `_meta["x.ai/tool"].kind` stays `enter_plan`.
    // The completed frame (worst case) must still resolve to the canonical name
    // — which normalizes to "enterplanmode" so it hits <PlanModeCard> + the
    // tool-group run-break, matching the historical path.
    const name = inferLiveToolName({
      title: "Plan mode entered",
      kind: "other",
      rawInput: JSON.stringify({ variant: "EnterPlanMode" }),
      meta: {
        "x.ai/tool": {
          name: "enter_plan_mode",
          kind: "enter_plan",
          namespace: "grok_build",
          label: "Enter Plan Mode",
        },
      },
    })
    expect(name).toBe("enter_plan_mode")
    expect(normalizeToolName(name)).toBe("enterplanmode")
  })

  it("resolves exit_plan_mode from x.ai/tool.kind", () => {
    const name = inferLiveToolName({
      title: "Plan: Exit",
      kind: "other",
      rawInput: JSON.stringify({ variant: "ExitPlanMode" }),
      meta: { "x.ai/tool": { name: "exit_plan_mode", kind: "exit_plan" } },
    })
    expect(name).toBe("exit_plan_mode")
    expect(normalizeToolName(name)).toBe("exitplanmode")
  })

  it("does NOT hijack other Grok tools carrying x.ai/tool meta", () => {
    // A non-plan-mode Grok tool (run_terminal_command, kind "execute") keeps its
    // normal resolution — the plan-mode shortcut is scoped to enter/exit_plan.
    expect(
      inferLiveToolName({
        title: "run_terminal_command",
        kind: "execute",
        rawInput: JSON.stringify({ command: "pnpm build" }),
        meta: {
          "x.ai/tool": { name: "run_terminal_command", kind: "execute" },
        },
      })
    ).toBe("bash")
  })
})

describe("inferLiveToolName Grok identity via x.ai/tool.name", () => {
  // The three frames of ONE background-task poll, captured from a real session
  // (~/.grok/…/019fb314…). Grok rewrites `title` on every update, so the title
  // fallback named this single call three different things — the last one
  // colliding with the bash card it was polling.
  const meta = {
    "x.ai/tool": {
      version: 1,
      name: "get_command_or_subagent_output",
      kind: "background_task_action",
      namespace: "grok_build",
      label: "Background Task",
      read_only: true,
    },
  }

  it("keeps one identity across the whole mutating lifecycle", () => {
    const announced = inferLiveToolName({
      title: "get_command_or_subagent_output",
      kind: null,
      rawInput: JSON.stringify({ task_ids: ["term_b0d"], timeout_ms: 15000 }),
      meta,
    })
    const inFlight = inferLiveToolName({
      title: "Get task output: term_b0d9512484964551a5bac4f82a805ae2",
      kind: "other",
      rawInput: JSON.stringify({
        variant: "TaskOutput",
        task_ids: ["term_b0d"],
        timeout_ms: 15000,
      }),
      meta,
    })
    // Completed: the title becomes the polled command — this used to collapse
    // to "bash" and fold into the launching command's tool group.
    const completed = inferLiveToolName({
      title: "/bin/bash -lc 'pnpm dev -- --port 3001' (term_b0d)",
      kind: "other",
      rawInput: JSON.stringify({
        variant: "TaskOutput",
        task_ids: ["term_b0d"],
        timeout_ms: 15000,
      }),
      meta,
    })

    expect(announced).toBe("get_command_or_subagent_output")
    expect(inFlight).toBe(announced)
    expect(completed).toBe(announced)
  })

  it("lets the input shape keep priority over the meta name", () => {
    // Grok's edit tool: the meta name (`search_replace`) has no card of its own,
    // while the input shape routes it to the diff card. Input wins.
    expect(
      inferLiveToolName({
        title: "Edit `/tmp/a.ts`",
        kind: "edit",
        rawInput: JSON.stringify({
          file_path: "/tmp/a.ts",
          old_string: "a",
          new_string: "b",
        }),
        meta: { "x.ai/tool": { name: "search_replace", kind: "edit" } },
      })
    ).toBe("edit")
  })

  it("resolves an arg-less frame from the meta name", () => {
    // Before rawInput streams in there is nothing else to go on.
    expect(
      inferLiveToolName({
        title: "read_file",
        kind: null,
        rawInput: null,
        meta: { "x.ai/tool": { name: "read_file", kind: "read" } },
      })
    ).toBe("read")
  })

  it("ignores the generic `use_tool` MCP envelope", () => {
    // The backend unwraps the envelope into the title; the envelope name would
    // send every MCP call to the generic tool card instead.
    expect(
      inferLiveToolName({
        title: "codeg-mcp__delegate_to_agent",
        kind: "other",
        rawInput: JSON.stringify({ agent_type: "codex", task: "run build" }),
        meta: { "x.ai/tool": { name: "use_tool", kind: "use_tool" } },
      })
    ).toBe("delegate_to_agent")
  })
})

describe("normalizeToolName codex command-action titles", () => {
  it("resolves search command actions to grep", () => {
    // codex-acp announces a search-classified shell command with NO rawInput and
    // no tool name — only the title. Without this the whole title became the
    // "tool name": no search icon, an "other" tool-group tally, and a body that
    // dumped the raw {formatted_output, exit_code} envelope.
    for (const title of [
      "Search for 'Tests run:' in com.forwayaudio.app",
      "Search for 'TODO'",
      "Search in 'src/lib'",
      "Search",
    ]) {
      expect(normalizeToolName(title)).toBe("grep")
    }
  })

  it("resolves list-files command actions to glob", () => {
    expect(normalizeToolName("List files in 'src/components'")).toBe("glob")
    expect(normalizeToolName("List files")).toBe("glob")
  })

  it("keeps the sibling read command action on read", () => {
    expect(normalizeToolName("Read file 'src/lib/a.ts'")).toBe("read")
  })

  it("leaves unrelated titles alone", () => {
    // Note the trailing-quote strip normalizeToolName applies to unmatched names.
    expect(normalizeToolName("Research 'x' in y")).toBe("Research 'x' in y")
    expect(normalizeToolName("Searching for 'x'")).toBe("Searching for 'x")
  })

  it("infers the live name from the title when there is no rawInput", () => {
    expect(
      inferLiveToolName({
        title: "Search for 'Tests run:' in com.forwayaudio.app",
        kind: "search",
        rawInput: null,
      })
    ).toBe("grep")
    expect(
      inferLiveToolName({
        title: "List files in 'src'",
        kind: "read",
        rawInput: null,
      })
    ).toBe("glob")
  })
})

describe("inferLiveToolName codex plan_review marker", () => {
  it("classifies the seeded plan-review call from _meta.codex.kind", () => {
    // codex-acp ≥1.1.8 (#351): codeg seeds this tool call from the permission
    // request, so it has no rawInput and its title is a question. Only the
    // marker identifies it.
    expect(
      inferLiveToolName({
        title: "Implement this plan?",
        kind: "switch_mode",
        rawInput: null,
        meta: { codex: { kind: "plan_review", planItemId: "item-7" } },
      })
    ).toBe("plan_review")
  })

  it("keeps the marker ahead of the title heuristic", () => {
    // Guard the ordering: without the marker branch the human question would
    // reach normalizeToolName and become some arbitrary name. Assert the title
    // alone does NOT already resolve to plan_review, so the test above proves
    // the marker (not the title) did the work.
    expect(normalizeToolName("Implement this plan?")).not.toBe("plan_review")
  })

  it("does not fire for other codex meta or a non-plan_review kind", () => {
    expect(
      inferLiveToolName({
        title: "Implement this plan?",
        kind: "switch_mode",
        rawInput: null,
        meta: { codex: { kind: "mcp_tool_call" } },
      })
    ).not.toBe("plan_review")
    expect(codexMarksPlanReview(null)).toBe(false)
    expect(codexMarksPlanReview({ codex: { subagent: true } })).toBe(false)
    expect(codexMarksPlanReview({ codex: { kind: "plan_review" } })).toBe(true)
  })

  it("still lets a real input shape win over the marker", () => {
    // The marker sits below inferFromInput, so a call that actually carries a
    // command is a bash call regardless of a stray marker.
    expect(
      inferLiveToolName({
        title: "Implement this plan?",
        kind: "execute",
        rawInput: JSON.stringify({ command: "pnpm test" }),
        meta: { codex: { kind: "plan_review" } },
      })
    ).toBe("bash")
  })
})

// Qoder ships a human sentence as the ACP `title` for every MCP call
// (`"<tool> (<server> MCP Server)"`, built by `GN`'s default branch) and hangs
// the authoritative SDK name off `_meta.qoder.toolName` (`AOn`). Before that
// meta was read, only `delegate_to_agent` reached its card live — rescued by
// the broker's own `codeg.delegation` marker — while every other codeg-mcp
// companion kept the sentence as its "name" and fell through to the generic
// tool shell. Shapes below are verbatim from a real qodercli 1.1.25 session.
describe("inferLiveToolName resolves Qoder's authoritative _meta.qoder.toolName", () => {
  const qoderMcpCall = (tool: string, input: unknown) => ({
    title: `${tool} (codeg-mcp MCP Server)`,
    kind: "other",
    rawInput: JSON.stringify(input),
    meta: { qoder: { toolName: `mcp__codeg-mcp__${tool}` } },
  })

  it.each([
    ["delegate_to_agent", { agent_type: "codex", task: "run pnpm build" }],
    ["get_delegation_status", { task_ids: ["081139e7"], wait_ms: 60000 }],
    ["cancel_delegation", { task_id: "081139e7" }],
    ["check_user_feedback", {}],
    ["ask_user_question", { questions: [{ question: "which?" }] }],
    ["get_session_info", { session_id: 2122, max_messages: 20 }],
    ["task_progress", { message: "tests passing" }],
    ["task_complete", { verdict: "success", summary: "done" }],
    ["create_automation", { name: "nightly", prompt: "…", cron: "7 * * * *" }],
    ["create_work_task", { title: "fix", prompt: "…" }],
  ])("resolves %s to its canonical card name", (tool, input) => {
    const expected = tool === "ask_user_question" ? "question" : tool
    expect(inferLiveToolName(qoderMcpCall(tool, input))).toBe(expected)
  })

  it("resolves the frame captured verbatim from qodercli 1.1.25", () => {
    // Recorded off a live `qoder --acp` turn against a stdio MCP server named
    // `codeg-mcp` — copied byte-for-byte from the session/update payload:
    //   {"title":"get_delegation_status (codeg-mcp MCP Server)","kind":"other",
    //    "_meta":{"qoder":{"toolName":"mcp__codeg-mcp__get_delegation_status"}},
    //    "rawInput":{"task_ids":["081139e7"]}}
    expect(
      inferLiveToolName({
        title: "get_delegation_status (codeg-mcp MCP Server)",
        kind: "other",
        rawInput: JSON.stringify({ task_ids: ["081139e7"] }),
        meta: {
          qoder: { toolName: "mcp__codeg-mcp__get_delegation_status" },
        },
      })
    ).toBe("get_delegation_status")
  })

  it("proves the title alone could never have resolved these", () => {
    // Guard the ordering: the MCP sentence is not collapsible by any alias or
    // suffix rule, so the assertions above prove the meta did the work.
    expect(
      normalizeToolName("get_delegation_status (codeg-mcp MCP Server)")
    ).not.toBe("get_delegation_status")
    expect(
      inferLiveToolName({ ...qoderMcpCall("task_progress", {}), meta: null })
    ).not.toBe("task_progress")
  })

  it("rescues cancel_delegation from the generic 'task' input shape", () => {
    // `{task_id}` is `inferFromInput`'s "task" shape, so the companion-set
    // resolution MUST sit ahead of it — same guarantee claude-agent-acp gets.
    expect(
      inferLiveToolName({
        title: "cancel_delegation (codeg-mcp MCP Server)",
        kind: "other",
        rawInput: JSON.stringify({ task_id: "t1" }),
        meta: null,
      })
    ).toBe("task")
  })

  it("keeps input-shape classification ahead of the meta name", () => {
    // The general Qoder override sits BELOW `inferFromInput` (like Grok's), so
    // a native tool whose payload carries a real shape keeps its own answer.
    expect(
      inferLiveToolName({
        title: "pnpm build",
        kind: "execute",
        rawInput: JSON.stringify({ command: "pnpm build" }),
        meta: { qoder: { toolName: "Bash" } },
      })
    ).toBe("bash")
    expect(
      inferLiveToolName({
        title: "Agent",
        kind: "think",
        rawInput: JSON.stringify({ subagent_type: "explore", prompt: "…" }),
        meta: { qoder: { toolName: "Agent" } },
      })
    ).toBe("agent")
  })

  it("resolves Qoder's native tools when the input shape is silent", () => {
    expect(
      inferLiveToolName({
        title: "Exit plan mode",
        kind: "switch_mode",
        rawInput: JSON.stringify({ plan: "do the thing" }),
        meta: { qoder: { toolName: "ExitPlanMode" } },
      })
    ).toBe("exitplanmode")
    expect(
      inferLiveToolName({
        title: "Skill",
        kind: "other",
        rawInput: JSON.stringify({ skill: "commit" }),
        meta: { qoder: { toolName: "Skill" } },
      })
    ).toBe("skill")
  })

  it("ignores a malformed or absent qoder meta", () => {
    for (const meta of [
      null,
      {},
      { qoder: null },
      { qoder: {} },
      { qoder: { toolName: "" } },
      { qoder: { toolName: 42 } },
    ] as Array<Record<string, unknown> | null>) {
      expect(
        inferLiveToolName({
          title: "whatever",
          kind: "other",
          rawInput: null,
          meta,
        })
      ).toBe("whatever")
    }
  })
})

describe("toolCallMovedToBackground", () => {
  it("reads the codex-acp 1.10 marker verbatim off the wire", () => {
    // The whole `tool_call_update` codex sends when a command goes background —
    // no status, no content, no output, and crucially NO `version` key inside
    // `air` (its `sessionFailure` sibling has one; gating on it here would make
    // the badge never appear).
    expect(
      toolCallMovedToBackground({
        jetbrains: { air: { asyncTasks: { backgrounded: true } } },
      })
    ).toBe(true)
    // A `version` alongside it must not break the read either, in case the
    // adapter ever starts stamping one.
    expect(
      toolCallMovedToBackground({
        jetbrains: { air: { version: 1, asyncTasks: { backgrounded: true } } },
      })
    ).toBe(true)
  })

  it("stays false for every other meta shape", () => {
    for (const meta of [
      null,
      undefined,
      {},
      // The AIR sibling that DOES ride this envelope — reading it as a
      // background marker would badge every failing turn's tool calls.
      { jetbrains: { air: { version: 1, sessionFailure: { id: "x" } } } },
      { jetbrains: { air: { asyncTasks: {} } } },
      // Strict equality: only a literal `true` counts.
      { jetbrains: { air: { asyncTasks: { backgrounded: false } } } },
      { jetbrains: { air: { asyncTasks: { backgrounded: "true" } } } },
      { jetbrains: { air: { asyncTasks: { backgrounded: 1 } } } },
      // Missing a level, or the wrong nesting.
      { air: { asyncTasks: { backgrounded: true } } },
      { jetbrains: { asyncTasks: { backgrounded: true } } },
      { asyncTasks: { backgrounded: true } },
      { jetbrains: { air: "backgrounded" } },
    ] as (Record<string, unknown> | null | undefined)[]) {
      expect(toolCallMovedToBackground(meta)).toBe(false)
    }
  })
})

// The historical path reads the raw `mcp__codeg-mcp__<tool>` name straight out
// of the transcript, so every host prefix/separator must collapse to the same
// canonical name the live path now produces — otherwise a reload swaps a card
// back to the generic tool shell.
describe("normalizeToolName collapses the codeg-mcp workbench companions", () => {
  const TOOLS = [
    "get_session_info",
    "task_progress",
    "task_complete",
    "create_automation",
    "create_work_task",
  ] as const

  it.each(TOOLS)("collapses every host spelling of %s", (tool) => {
    for (const spelling of [
      tool,
      `mcp__codeg-mcp__${tool}`,
      `mcp__codeg__${tool}`,
      `codeg-mcp/${tool}`,
      `codeg-mcp.${tool}`,
      `codeg-mcp:${tool}`,
    ]) {
      expect(normalizeToolName(spelling)).toBe(tool)
    }
  })

  it("keeps task_progress/task_complete out of the generic 'task' tool", () => {
    // Regression: the freeform `^task(\b|[_\s:-])` rule used to swallow both,
    // which is why they rendered as an empty "任务" card with no detail.
    expect(normalizeToolName("task_progress")).not.toBe("task")
    expect(normalizeToolName("task_complete")).not.toBe("task")
    // …without disturbing the generic task tools that rule exists for.
    expect(normalizeToolName("task")).toBe("task")
    expect(normalizeToolName("task_update")).toBe("taskupdate")
  })
})

describe("inferLiveToolName meta.opencode.toolName override", () => {
  // Every row below is a frame captured from opencode 1.18.30 driven over real
  // ACP: the arg-less opening `tool_call`, the `in_progress` update that fills
  // `rawInput`, and the completion, which drops `kind`/`rawInput` and rewrites
  // `title` into a display label. The backend records the opening frame's title
  // as `_meta.opencode.toolName` (`stamp_opencode_tool_name`); the merged block
  // the renderer classifies therefore carries the completion's title with the
  // opening frame's meta.
  const meta = (toolName: string) => ({ opencode: { toolName } })
  const call = (
    toolName: string,
    completedTitle: string | null,
    kind: string | null,
    rawInput: unknown
  ) =>
    inferLiveToolName({
      title: completedTitle,
      kind,
      rawInput: JSON.stringify(rawInput),
      meta: meta(toolName),
    })

  it("names the tools whose input shape is ambiguous", () => {
    // `glob` and `grep` take the SAME `{pattern, path}` arguments, so the input
    // shape alone resolved both to "grep" — while the history parser, reading
    // `part.tool`, kept them apart. Same story for `lsp_*` ({path} → "read") and
    // an MCP tool taking `{query}` (→ "websearch").
    expect(call("glob", null, "search", { pattern: "*.txt" })).toBe("glob")
    expect(
      call("grep", "third", "search", { pattern: "third", path: "/w" })
    ).toBe("grep")
    expect(
      call("lsp_diagnostics", "3 errors", "other", { path: "/w/a.ts" })
    ).toBe("lsp")
    expect(
      call("context7_query-docs", "docs", "other", { query: "effect" })
    ).toBe("context7_query-docs")
  })

  it("keeps the classification the input shape already got right", () => {
    expect(
      call("read", "notes.txt", "read", { filePath: "/w/notes.txt" })
    ).toBe("read")
    expect(
      call("edit", "notes.txt", "edit", {
        filePath: "/w/notes.txt",
        oldString: "a",
        newString: "b",
      })
    ).toBe("edit")
    expect(
      call("write", "a.ts", "edit", { filePath: "/w/a.ts", content: "x" })
    ).toBe("write")
    expect(
      call("bash", "echo probe-ok", "execute", { command: "echo probe-ok" })
    ).toBe("bash")
    expect(call("todowrite", "3 todos", "other", { todos: [] })).toBe(
      "todowrite"
    )
    expect(call("webfetch", "webfetch", "fetch", { url: "https://x" })).toBe(
      "webfetch"
    )
    expect(
      call("apply_patch", "apply_patch", "edit", {
        patchText: "*** Begin Patch\n*** End Patch",
      })
    ).toBe("apply_patch")
  })

  it("still routes a delegation companion by its own markers", () => {
    // OpenCode names an MCP tool `<server>_<tool>`; the suffix rules collapse it
    // to the canonical companion name the delegation cards dispatch on.
    expect(
      call("codeg-mcp_get_delegation_status", "status", "other", {
        task_ids: ["t1"],
      })
    ).toBe("get_delegation_status")
    expect(
      call("codeg-mcp_ask_user_question", "asked", "other", { questions: [] })
    ).toBe("question")
  })

  it("never overrides the backend's authoritative sub-agent title", () => {
    // OpenCode's sub-agent launcher IS the `task` tool; the backend rewrites the
    // title to the "agent" sentinel once `subagent_type` arrives, and the marker
    // recorded from the arg-less opening frame must not pull it back to "task".
    expect(
      inferLiveToolName({
        title: "agent",
        kind: "think",
        rawInput: JSON.stringify({
          description: "explore",
          prompt: "look around",
          subagent_type: "general",
        }),
        meta: meta("task"),
      })
    ).toBe("agent")
  })

  it("ignores a malformed or absent marker", () => {
    const shape = {
      title: "notes.txt",
      kind: null,
      rawInput: JSON.stringify({ filePath: "/w/notes.txt" }),
    }
    expect(inferLiveToolName({ ...shape, meta: null })).toBe("read")
    expect(inferLiveToolName({ ...shape, meta: { opencode: {} } })).toBe("read")
    expect(
      inferLiveToolName({ ...shape, meta: { opencode: { toolName: "  " } } })
    ).toBe("read")
    expect(inferLiveToolName({ ...shape, meta: { opencode: "glob" } })).toBe(
      "read"
    )
  })
})
