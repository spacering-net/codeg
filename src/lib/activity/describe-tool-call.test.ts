import { describe, expect, it } from "vitest"

import type { AdaptedToolCallPart } from "@/lib/adapters/ai-elements-adapter"
import { describeToolCall, toolStepKind } from "./describe-tool-call"

let seq = 0
function call(
  toolName: string,
  input: unknown,
  overrides: Partial<AdaptedToolCallPart> = {}
): AdaptedToolCallPart {
  seq += 1
  return {
    type: "tool-call",
    toolCallId: `call-${seq}`,
    toolName,
    input:
      input === null
        ? null
        : typeof input === "string"
          ? input
          : JSON.stringify(input),
    state: "output-available",
    output: null,
    ...overrides,
  }
}

describe("toolStepKind", () => {
  const cases: Array<[string, unknown, string]> = [
    // Claude Code
    ["Read", { file_path: "/r/a.ts" }, "read"],
    ["Grep", { pattern: "x" }, "search"],
    ["Glob", { pattern: "**/*.ts" }, "glob"],
    ["Bash", { command: "ls" }, "command"],
    ["PowerShell", { command: "dir" }, "command"],
    // A watch, not a command: never folded into "Ran N commands".
    ["Monitor", { command: "tail -f log", description: "errors" }, "monitor"],
    ["SandboxNetworkAccess", { host: "example.com" }, "network"],
    [
      "Edit",
      { file_path: "/r/a.ts", old_string: "a", new_string: "b" },
      "edit",
    ],
    ["Write", { file_path: "/r/a.ts", content: "x" }, "edit"],
    ["NotebookEdit", { notebook_path: "/r/n.ipynb" }, "edit"],
    ["WebFetch", { url: "https://a.dev" }, "fetch"],
    ["WebSearch", { query: "q" }, "web-search"],
    ["Skill", { skill: "pdf" }, "skill"],
    ["TodoWrite", { todos: [] }, "todo"],
    ["Agent", { prompt: "p", subagent_type: "Explore" }, "agent"],
    ["Task", { prompt: "p", subagent_type: "Explore" }, "generic"],
    ["ExitPlanMode", { plan: "# P" }, "plan-mode"],
    ["EnterPlanMode", {}, "plan-mode"],
    ["AskUserQuestion", { questions: [] }, "question"],
    ["mcp__linear__get_issue", { id: "HVAC-1" }, "mcp"],
    // codeg's own MCP companions are never third-party MCP rows
    ["mcp__codeg-mcp__delegate_to_agent", { task: "t" }, "delegation"],
    // opencode 2.x code-mode: the delegation call rides inside the `execute`
    // tool's `code` source string, so only the input shape can classify it.
    [
      "execute",
      {
        code: 'await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: `t` })',
      },
      "delegation",
    ],
    // Any other code-mode `execute` is a script row: `execute` normalizes to
    // `bash`, but its input is the script, which a command row would show as
    // an empty command line.
    ["execute", { code: "return 1 + 1" }, "script"],
    // A `{code}` input on a real command tool stays a command.
    ["bash", { command: "node -e x", code: "x" }, "command"],
    // OpenCode 2's renamed tools (packages/core/src/tool/plugin, 2.2.0).
    ["shell", { command: "ls" }, "command"],
    ["patch", { patchText: "*** Begin Patch\n*** End Patch" }, "edit"],
    [
      "subagent",
      {
        agent: "general",
        description: "d",
        prompt: "p",
        subagent_type: "general",
      },
      "agent",
    ],
    ["skill", { id: "probe-skill" }, "skill"],
    // Another tool's `code` argument shaped like the call is no delegation.
    [
      "mcp__playwright__browser_run_code",
      {
        code: 'await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: `t` })',
      },
      "mcp",
    ],
    [
      "mcp__codeg-mcp__get_delegation_status",
      { task_ids: [] },
      "delegation-status",
    ],
    [
      "mcp__codeg-mcp__cancel_delegation",
      { task_id: "t" },
      "delegation-cancel",
    ],
    [
      "mcp__codeg-mcp__resume_delegation",
      { task_id: "t" },
      "delegation-resume",
    ],
    ["mcp__codeg-mcp__check_user_feedback", {}, "feedback"],
    ["mcp__codeg-mcp__task_progress", {}, "workbench"],
    // codex
    ["exec_command", { cmd: "ls" }, "command"],
    ["shell_command", { command: "ls" }, "command"],
    ["apply_patch", "*** Begin Patch\n*** End Patch", "edit"],
    ["wait", { cell_id: "7" }, "shell-session"],
    ["write_stdin", { session_id: 7, chars: "" }, "shell-session"],
    ["codex_script", { source: "x" }, "script"],
    ["view_image", { path: "/r/a.png" }, "read"],
    ["create_goal", { objective: "o" }, "goal"],
    ["linear/get_issue", { id: "1" }, "mcp"],
    // Cline
    ["execute_command", { command: "ls" }, "command"],
    ["list_files", { path: "src" }, "glob"],
    ["search_files", { regex: "x" }, "search"],
    ["attempt_completion", { result: "done" }, "completion"],
    ["use_mcp_tool", { server_name: "gh", tool_name: "search" }, "mcp"],
    // pi
    ["find", { pattern: "*.ts" }, "glob"],
    ["ls", { path: "src" }, "list"],
    // Grok
    ["run_terminal_command", { command: "ls" }, "command"],
    // unknown
    ["lsp_diagnostics", { path: "a.ts" }, "generic"],
  ]
  it.each(cases)("%s → %s", (name, input, expected) => {
    expect(toolStepKind(call(name, input))).toBe(expected)
  })

  it("routes a compaction marker regardless of the tool name", () => {
    expect(
      toolStepKind(call("tool", null, { meta: { contextCompaction: true } }))
    ).toBe("compaction")
  })
})

describe("describeToolCall: exploration", () => {
  it("describes a read with its line count and range", () => {
    const tool = describeToolCall(
      call(
        "Read",
        { file_path: "/repo/agent/src/q.py", offset: 40, limit: 20 },
        { output: JSON.stringify({ start_line: 40, content: "a\nb\nc" }) }
      )
    )
    expect(tool.target).toEqual({
      text: "src/q.py",
      full: "/repo/agent/src/q.py",
      path: "/repo/agent/src/q.py",
    })
    expect(tool.detail).toBe("L40–59")
    expect(tool.metric).toEqual({ kind: "lines", count: 3 })
  })

  it("does not count lines of a read still in flight", () => {
    const tool = describeToolCall(
      call("Read", { file_path: "/r/a.ts" }, { state: "input-available" })
    )
    expect(tool.status).toBe("running")
    expect(tool.metric).toBeNull()
  })

  it("counts grep hits and shows the scope", () => {
    const tool = describeToolCall(
      call(
        "Grep",
        { pattern: "source_bindings", path: "/repo/agent/src" },
        { output: "a.py:1:x\na.py:9:y\nb.py:3:z\nc.py:4:w" }
      )
    )
    expect(tool.target?.text).toBe("source_bindings")
    expect(tool.detail).toBe("agent/src")
    expect(tool.metric).toEqual({ kind: "matches", count: 4, files: 3 })
  })

  it("reports a grep that matched nothing", () => {
    const tool = describeToolCall(
      call("Grep", { pattern: "zzz" }, { output: "" })
    )
    expect(tool.status).toBe("succeeded")
    expect(tool.metric).toEqual({ kind: "noMatch" })
  })

  it("treats a pattern-less glob as a listing", () => {
    const tool = describeToolCall(
      call("list_files", { path: "/repo/src" }, { output: "a.ts\nb.ts" })
    )
    expect(tool.kind).toBe("list")
    expect(tool.metric).toEqual({ kind: "files", count: 2 })
  })

  it("shows a fetch's URL without its scheme", () => {
    expect(
      describeToolCall(call("WebFetch", { url: "https://react.dev/learn" }))
        .target?.text
    ).toBe("react.dev/learn")
  })
})

describe("describeToolCall: commands", () => {
  it("shows the command, not Claude's description", () => {
    const tool = describeToolCall(
      call("Bash", {
        command: "pnpm --filter web test",
        description: "Run web unit tests",
      })
    )
    expect(tool.command).toMatchObject({
      display: "pnpm --filter web test",
      lineCount: 1,
      heredoc: null,
      description: "Run web unit tests",
      session: null,
    })
    expect(tool.exit).toBeNull()
  })

  it("reports a failed command's exit code", () => {
    const tool = describeToolCall(
      call(
        "Bash",
        { command: "pnpm test" },
        {
          state: "output-error",
          output: "Tests: 1 failed\n\nExit code 1",
          errorText: "Tests: 1 failed\n\nExit code 1",
        }
      )
    )
    expect(tool.status).toBe("failed")
    expect(tool.exit).toEqual({ code: 1, signal: null })
  })

  // OpenCode 2 completes a command that exited non-zero SUCCESSFULLY, closing
  // its result with an `Exited with code N` notice block
  // (packages/core/src/shell/result.ts, 2.2.0 capture), and the live call
  // carries the code as `_meta["codeg.exitCode"]` too.
  it("reads OpenCode 2's exit notice as the command's failure", () => {
    const fromText = describeToolCall(
      call(
        "shell",
        { command: "pnpm build" },
        { output: "ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL\n\nExited with code 1" }
      )
    )
    expect(fromText.status).toBe("failed")
    expect(fromText.exit).toEqual({ code: 1, signal: null })

    const fromMeta = describeToolCall(
      call(
        "shell",
        { command: "make" },
        {
          output: "make: *** [all] Error 2\n",
          meta: { opencode: { toolName: "shell" }, "codeg.exitCode": 2 },
        }
      )
    )
    expect(fromMeta.status).toBe("failed")
    expect(fromMeta.exit).toEqual({ code: 2, signal: null })
  })

  it("reads a missing path the way it does for every agent", () => {
    // The 2.2.0 capture's `ls` of a missing directory: the notice is framing,
    // so what is left is the "not found" answer, as for Claude Code's `ls`.
    const tool = describeToolCall(
      call(
        "shell",
        { command: "ls /definitely-not-here" },
        {
          output:
            "ls: /definitely-not-here: No such file or directory\n\nExited with code 1",
        }
      )
    )
    expect(tool.status).toBe("succeeded")
    expect(tool.exit).toEqual({ code: 1, signal: null })
    expect(tool.exitMeaning).toBe("notFound")
  })

  it("keeps OpenCode 2's no-match search a success", () => {
    const tool = describeToolCall(
      call(
        "shell",
        { command: "rg -n 'nothing-here' src" },
        { output: "Exited with code 1" }
      )
    )
    expect(tool.status).toBe("succeeded")
    expect(tool.exit).toEqual({ code: 1, signal: null })
  })

  it("leaves a succeeded command's own text alone", () => {
    // The program printed the words, mid-output: not the agent's notice.
    const tool = describeToolCall(
      call(
        "shell",
        { command: "./report.sh" },
        { output: "Exited with code 3\nall checks passed" }
      )
    )
    expect(tool.status).toBe("succeeded")
    expect(tool.exit).toBeNull()
  })

  it("prefers the exit code the transcript kept as a field", () => {
    const tool = describeToolCall(
      call(
        "bash",
        { command: "make" },
        {
          state: "output-error",
          output: "boom\n\nExit code 1",
          errorText: "boom\n\nExit code 1",
          exitCode: 2,
        }
      )
    )
    expect(tool.exit).toEqual({ code: 2, signal: null })
  })

  it("settles a search that matched nothing as done, saying so", () => {
    // Claude Code: the failure is the bare `Exit code 1`.
    const claude = describeToolCall(
      call(
        "Bash",
        { command: "rg -n 'source_bindings' src" },
        { state: "output-error", errorText: "Exit code 1" }
      )
    )
    expect(claude.status).toBe("succeeded")
    expect(claude.exitMeaning).toBe("noMatch")
    expect(claude.exit).toEqual({ code: 1, signal: null })
    // claude-agent-acp fences it for a client without a terminal channel.
    expect(
      describeToolCall(
        call(
          "Bash",
          { command: "grep -rn TODO src" },
          { state: "output-error", errorText: "```\nExit code 1\n```" }
        )
      ).exitMeaning
    ).toBe("noMatch")
    // codex: its framing, the code kept as a field.
    const codex = describeToolCall(
      call(
        "exec_command",
        { cmd: '/bin/zsh -lc "test -f package.json"' },
        {
          state: "output-error",
          errorText:
            "Chunk ID: 1a2b\nWall time: 0.0100 seconds\nProcess exited with code 1\nOriginal token count: 0\nOutput:\n",
          exitCode: 1,
        }
      )
    )
    expect(codex.status).toBe("succeeded")
    expect(codex.exitMeaning).toBe("false")
  })

  it("keeps a failure that only looks like an answer", () => {
    const tool = describeToolCall(
      call(
        "Bash",
        { command: "grep -rn TODO missing-dir" },
        {
          state: "output-error",
          errorText:
            "grep: missing-dir: No such file or directory\n\nExit code 2",
        }
      )
    )
    expect(tool.status).toBe("failed")
    expect(tool.exitMeaning).toBeNull()
  })

  it("names a failure its code stands for", () => {
    const notFound = describeToolCall(
      call(
        "Bash",
        { command: "pyhton x.py" },
        {
          state: "output-error",
          errorText: "Exit code 127\n(eval):1: command not found: pyhton",
        }
      )
    )
    expect(notFound.status).toBe("failed")
    expect(notFound.exitMeaning).toBe("commandNotFound")
    const killed = describeToolCall(
      call(
        "Bash",
        { command: "node build.js" },
        { state: "output-error", errorText: "Killed\n\nExit code 137" }
      )
    )
    expect(killed.status).toBe("failed")
    expect(killed.exit).toEqual({ code: 137, signal: "SIGKILL" })
  })

  it("leaves the exit unknown when a failure reports none", () => {
    const tool = describeToolCall(
      call(
        "Bash",
        { command: "x" },
        { state: "output-error", errorText: "something broke" }
      )
    )
    expect(tool.exit).toBeNull()
  })

  it("recognizes a heredoc script", () => {
    const tool = describeToolCall(
      call("Bash", { command: "python - <<'PY'\nprint(1)\nprint(2)\nPY" })
    )
    expect(tool.command?.heredoc).toEqual({
      head: "python - <<'PY'",
      interpreter: "python",
      bodyLines: 2,
    })
    expect(tool.command?.lineCount).toBe(4)
  })

  it("flags a background launch with its task id", () => {
    const tool = describeToolCall(
      call(
        "Bash",
        { command: "python regen.py", run_in_background: true },
        {
          output:
            "Command running in background with ID: beecec7d. Output is being written to: /tmp/x",
        }
      )
    )
    expect(tool.background).toEqual({ taskId: "beecec7d" })
  })

  it("flags codex's backgrounded call while it is unsettled", () => {
    const meta = { jetbrains: { air: { asyncTasks: { backgrounded: true } } } }
    expect(
      describeToolCall(
        call(
          "exec_command",
          { cmd: "pnpm dev" },
          { state: "input-available", meta }
        )
      ).background
    ).toEqual({ taskId: null })
    expect(
      describeToolCall(call("exec_command", { cmd: "pnpm dev" }, { meta }))
        .background
    ).toBeNull()
  })

  it("reads codex's wall time", () => {
    const tool = describeToolCall(
      call(
        "exec_command",
        { cmd: "make" },
        { output: "Chunk ID: 1\nWall time: 14.2 seconds\nOutput:\nok" }
      )
    )
    expect(tool.command?.durationMs).toBe(14200)
  })

  it("describes codex's session tools", () => {
    expect(
      describeToolCall(
        call("wait", { cell_id: "17", session_command: "bash -lc 'pnpm dev'" })
      ).command
    ).toMatchObject({
      display: "pnpm dev",
      session: { verb: "wait", sessionId: "17", stdin: null },
    })
    expect(
      describeToolCall(call("write_stdin", { session_id: 17, chars: "\u0003" }))
        .command?.session
    ).toEqual({ verb: "stdin", sessionId: "17", stdin: "\u0003" })
    expect(
      describeToolCall(call("wait", { cell_id: "17", terminate: true })).command
        ?.session?.verb
    ).toBe("terminate")
  })
})

describe("describeToolCall: code-mode scripts", () => {
  // OpenCode 2.2.0's `execute` running an MCP tool (live capture): the script
  // is the input, the calls it made ride the `_meta`, the result is the text.
  const code =
    "const r = await tools.probe.echo({ text: 'hi from code mode' });\nreturn r"

  it("titles the row with the tools the script called", () => {
    const tool = describeToolCall(
      call(
        "execute",
        { code },
        {
          output: '{\n  "echoed": "hi from code mode"\n}',
          meta: {
            opencode: { toolName: "execute" },
            "codeg.codeModeCalls": [
              {
                tool: "probe.echo",
                status: "completed",
                input: { text: "hi from code mode" },
              },
            ],
          },
        }
      )
    )
    expect(tool.kind).toBe("script")
    expect(tool.command?.display).toBe("probe.echo")
    expect(tool.command?.lineCount).toBe(2)
  })

  it("titles a script whose calls are not known yet by its first line", () => {
    const tool = describeToolCall(
      call("execute", { code }, { state: "input-available" })
    )
    expect(tool.kind).toBe("script")
    expect(tool.command?.display).toBe(
      "const r = await tools.probe.echo({ text: 'hi from code mode' });"
    )
  })
})

describe("describeToolCall: Claude Code monitors and network requests", () => {
  // Claude Code 2.1.310's result for a started Monitor, verbatim.
  const STARTED =
    "Monitor started (task bttyx34fg, expires in 5m unless the source ends first; you get one notice at expiry \u2014 re-arm if you still need the watch). You will be notified on each event. Keep working \u2014 do not poll or sleep. Events may arrive while you are waiting for the user \u2014 an event is not their reply."

  it("draws a started monitor by its command, description and task", () => {
    const tool = describeToolCall(
      call(
        "Monitor",
        {
          command: "for i in 1 2 3; do echo event-$i; sleep 2; done",
          description: "probe monitor",
        },
        { output: STARTED }
      )
    )
    expect(tool.kind).toBe("monitor")
    expect(tool.command).toMatchObject({
      display: "for i in 1 2 3; do echo event-$i; sleep 2; done",
      description: "probe monitor",
      lineCount: 1,
    })
    expect(tool.command?.websocket).toBeUndefined()
    expect(tool.background).toEqual({ taskId: "bttyx34fg" })
  })

  it("reads a persistent monitor's task the same way", () => {
    const tool = describeToolCall(
      call(
        "Monitor",
        {
          command: "tail -f app.log",
          description: "app log",
          persistent: true,
        },
        {
          output:
            "Monitor started (task b2, persistent \u2014 runs until TaskStop or session end). You will be notified on each event.",
        }
      )
    )
    expect(tool.background).toEqual({ taskId: "b2" })
  })

  it("names a WebSocket monitor by its URL", () => {
    const tool = describeToolCall(
      call("Monitor", {
        description: "CI events",
        ws: { url: "wss://ci.example.com/events" },
      })
    )
    expect(tool.command).toMatchObject({
      display: "wss://ci.example.com/events",
      description: "CI events",
      heredoc: null,
      websocket: true,
    })
    expect(tool.background).toBeNull()
  })

  it("names no task for a monitor that did not start", () => {
    const tool = describeToolCall(
      call(
        "Monitor",
        { command: "tail -f log", description: "log" },
        {
          state: "output-error",
          errorText:
            "This call was interrupted before the monitor started; nothing is running.",
        }
      )
    )
    expect(tool.status).toBe("failed")
    expect(tool.background).toBeNull()
  })

  it("names the host a sandbox network request is for", () => {
    const tool = describeToolCall(
      call("SandboxNetworkAccess", { host: "example.com" })
    )
    expect(tool.kind).toBe("network")
    expect(tool.target).toEqual({ text: "example.com" })
  })
})

describe("describeToolCall: edits", () => {
  it("names a single file and totals its lines", () => {
    const tool = describeToolCall(
      call("Edit", {
        file_path: "/repo/agent/q.py",
        old_string: "a",
        new_string: "b\nc\nd",
      })
    )
    expect(tool.target).toMatchObject({ path: "/repo/agent/q.py" })
    expect(tool.metric).toEqual({ kind: "diff", additions: 3, deletions: 1 })
  })

  it("hides the counts while the edit is still running", () => {
    const tool = describeToolCall(
      call(
        "Edit",
        { file_path: "/r/a.ts", old_string: "a", new_string: "b" },
        { state: "input-available" }
      )
    )
    expect(tool.metric).toBeNull()
  })

  it("leaves the target empty for a multi-file patch", () => {
    const patch =
      "*** Begin Patch\n*** Update File: a.ts\n+x\n*** Update File: b.ts\n-y\n*** End Patch"
    const tool = describeToolCall(call("apply_patch", patch))
    expect(tool.files).toHaveLength(2)
    expect(tool.target).toBeNull()
    expect(tool.metric).toEqual({ kind: "diff", additions: 1, deletions: 1 })
  })
})

describe("describeToolCall: MCP and generic tools", () => {
  it("splits the server off and summarizes arguments and result", () => {
    const tool = describeToolCall(
      call(
        "mcp__linear__get_issue",
        { id: "HVAC-212" },
        {
          output: JSON.stringify({
            title: "Inactive bindings leak into report",
            state: "In Progress",
          }),
        }
      )
    )
    expect(tool.mcp).toEqual({ server: "linear", tool: "get_issue" })
    expect(tool.target).toEqual({ text: "get_issue" })
    expect(tool.detail).toBe("HVAC-212 · Inactive bindings leak into report")
  })

  it("reads Cline's use_mcp_tool envelope", () => {
    const tool = describeToolCall(
      call("use_mcp_tool", {
        server_name: "github",
        tool_name: "search_code",
        arguments: { q: "useMemo" },
      })
    )
    expect(tool.mcp).toEqual({ server: "github", tool: "search_code" })
    expect(tool.detail).toBe("useMemo")
  })

  it("names an unknown tool by its raw name and first argument", () => {
    const tool = describeToolCall(
      call("lsp_diagnostics", { id: "1", path: "src/a.ts" })
    )
    expect(tool.target).toEqual({ text: "lsp_diagnostics" })
    expect(tool.detail).toBe("src/a.ts")
  })

  it("prefers Claude's skill marker", () => {
    expect(
      describeToolCall(
        call(
          "Skill",
          { skill: "x" },
          { meta: { claudeCode: { skill: "pdf" } } }
        )
      ).target
    ).toEqual({ text: "pdf" })
  })

  it("caches per part object", () => {
    const part = call("Read", { file_path: "/r/a.ts" })
    expect(describeToolCall(part)).toBe(describeToolCall(part))
  })
})

describe("describeToolCall: approvals", () => {
  it("carries the approval a detail load stamped on the call", () => {
    const tool = describeToolCall(
      call(
        "Bash",
        { command: "git commit -am wip" },
        {
          meta: {
            "codeg.approval": {
              option_kind: "allow_once",
              option_name: "Allow",
              origin: "user",
              decided_at: "2026-10-22T09:41:12Z",
            },
          },
        }
      )
    )
    expect(tool.approval).toEqual({
      decision: "allowOnce",
      optionName: "Allow",
      origin: "user",
      decidedAt: "2026-10-22T09:41:12Z",
    })
  })

  it("has none when the call carries no stamp", () => {
    expect(
      describeToolCall(call("Read", { file_path: "/r/a.ts" })).approval
    ).toBeNull()
  })
})
