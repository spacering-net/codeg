/**
 * The redesign's reference turn, as backend `MessageTurn`s: three reads and a
 * grep, two commands (one a heredoc script), a Linear MCP lookup, an edit, a
 * failing test run, a Codex delegation, the passing re-run, a background
 * report job and the commit — then the closing answer. Used by the activity
 * model's tests and the gallery page.
 */

import type { ContentBlock, MessageTurn } from "@/lib/types"

export const MOCKUP_REPO = "/Users/demo/hvac"

export function toolUse(
  id: string,
  name: string,
  input: unknown,
  meta?: Record<string, unknown>
): ContentBlock {
  return {
    type: "tool_use",
    tool_use_id: id,
    tool_name: name,
    input_preview: typeof input === "string" ? input : JSON.stringify(input),
    meta: meta ?? null,
  }
}

export function toolResult(
  id: string,
  output: string,
  isError = false
): ContentBlock {
  return {
    type: "tool_result",
    tool_use_id: id,
    output_preview: output,
    is_error: isError,
  }
}

export const fixtureLines = (n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1}`).join("\n")

export const MOCKUP_USER_TURN: MessageTurn = {
  id: "turn-user",
  role: "user",
  timestamp: "2026-10-22T08:00:00Z",
  blocks: [
    {
      type: "text",
      text: "Check the web build and unit-test logs, fix anything broken in query_tasks, then commit.",
    },
  ],
}

const DELEGATION_TASK_ID = "14be49e7-2b1c-4c3e-9d7a-0f5e1a2b3c4d"
const DELEGATION_TASK =
  "Update the stale snapshot in web/lib/__fixtures__/tasks.json to match active-only bindings, then review the audit/report/state artifacts for regressions."

export const MOCKUP_ASSISTANT_TURN: MessageTurn = {
  id: "turn-assistant",
  role: "assistant",
  timestamp: "2026-10-22T08:00:02Z",
  duration_ms: 214000,
  model: "claude-opus-5-5",
  blocks: [
    {
      type: "thinking",
      text: "**Summarizing log status**\n\nI need to gather the logs and check the status succinctly while capturing all commands. Review prior tests first, inspect the relevant code without introducing new changes, and check the root Makefile docs to make sure nothing is missing.",
    },
    toolUse("t1", "Read", { file_path: `${MOCKUP_REPO}/Makefile` }),
    toolResult("t1", fixtureLines(84, "Makefile")),
    toolUse("t2", "Read", { file_path: `${MOCKUP_REPO}/web/package.json` }),
    toolResult("t2", fixtureLines(41, "package.json")),
    toolUse("t3", "Read", {
      file_path: `${MOCKUP_REPO}/agent/src/hvac_agent/query_tasks.py`,
    }),
    toolResult("t3", fixtureLines(212, "query_tasks.py")),
    toolUse("t4", "Grep", { pattern: "source_bindings", path: "agent/src" }),
    toolResult(
      "t4",
      [
        'agent/src/hvac_agent/query_tasks.py:44:            "source_bindings": tuple(binding for binding in item.source_bindings),',
        "agent/src/hvac_agent/query_tasks.py:88:    source_bindings: tuple[Binding, ...]",
        "agent/src/hvac_agent/report.py:17:    for b in task.source_bindings:",
        "agent/src/hvac_agent/state.py:203:        source_bindings=(),",
      ].join("\n")
    ),
    toolUse("t5", "Bash", {
      command:
        "git diff --check; git status --short -- web; tail -25 .local/hvac-audit-followup-20261022/web-build.log; tail -6 .local/hvac-audit-followup-20261022/root-unittest.log",
      description: "Check build and unit-test logs",
    }),
    toolResult(
      "t5",
      [
        "> next build",
        "",
        "▲ Next.js 16.4.0 (Turbopack)",
        "- Environments: .env.local",
        "✓ Running next.config.ts took 52ms",
        "",
        "  Creating an optimized production build ...",
        "✓ Compiled successfully in 2.8s",
        "✓ Generating static pages (14/14)",
        "",
        "Ran 31 tests",
        "OK",
      ].join("\n")
    ),
    toolUse("t6", "Bash", {
      command: [
        "agent/.venv/bin/python - <<'PY'",
        "import json",
        "from hvac_agent.query_tasks import load_tasks",
        "tasks = load_tasks('.local/hvac-audit-followup-20261022/state.json')",
        "for t in tasks:",
        "    print(t.id, len(t.source_bindings))",
        "PY",
      ].join("\n"),
    }),
    toolResult("t6", "T-101 3\nT-102 2\nT-103 3"),
    toolUse("t7", "mcp__linear__get_issue", { id: "HVAC-212" }),
    toolResult(
      "t7",
      JSON.stringify(
        {
          title: "Inactive bindings leak into report",
          state: "In Progress",
          labels: ["audit", "agent"],
        },
        null,
        2
      )
    ),
    {
      type: "thinking",
      text: "**Planning the fix**\n\nThe report copies every binding, including inactive ones. Filter where the tuple is built.",
    },
    toolUse("t8", "Edit", {
      file_path: `${MOCKUP_REPO}/agent/src/hvac_agent/query_tasks.py`,
      old_string:
        '            "source_bindings": tuple(binding for binding in item.source_bindings),',
      new_string:
        '            "source_bindings": tuple(\n                binding for binding in item.source_bindings if binding.active\n            ),',
      _start_line: 44,
    }),
    toolResult(
      "t8",
      `The file ${MOCKUP_REPO}/agent/src/hvac_agent/query_tasks.py has been updated successfully.`
    ),
    toolUse("t9", "Bash", {
      command: "pnpm --filter web test",
      description: "Run web unit tests",
    }),
    toolResult(
      "t9",
      [
        "FAIL  web/lib/tasks.test.ts > maps inactive bindings",
        "  Expected: 2",
        "  Received: 3",
        "",
        "  at web/lib/tasks.test.ts:58:22",
        "",
        "Tests: 1 failed, 47 passed, 48 total",
        "",
        "Exit code 1",
      ].join("\n"),
      true
    ),
    {
      type: "text",
      text: "The snapshot still encodes the old behavior, so I'm handing that update to Codex.",
    },
    toolUse(
      "t10",
      "mcp__codeg-mcp__delegate_to_agent",
      { agent_type: "codex", task: DELEGATION_TASK },
      {
        "codeg.delegation": {
          status: "completed",
          child_conversation_id: 77,
          task_id: DELEGATION_TASK_ID,
          task_preview: DELEGATION_TASK,
        },
      }
    ),
    toolResult(
      "t10",
      JSON.stringify({ task_id: DELEGATION_TASK_ID, status: "started" })
    ),
    toolUse("t11", "mcp__codeg-mcp__get_delegation_status", {
      task_ids: [DELEGATION_TASK_ID],
      wait_ms: 60000,
    }),
    toolResult(
      "t11",
      JSON.stringify({
        task_id: DELEGATION_TASK_ID,
        status: "completed",
        text: "Snapshot updated. 48/48 passing, no regressions in audit artifacts.",
        duration_ms: 94000,
        progress: {
          steps: 5,
          marks: ["ok", "ok", "failed", "ok", "ok"],
          last_step: "pnpm --filter web test",
        },
      })
    ),
    toolUse("t12", "Bash", {
      command: "pnpm --filter web test",
      description: "Run web unit tests",
    }),
    toolResult("t12", "Tests: 48 passed, 48 total"),
    toolUse("t13", "Bash", {
      command: "python scripts/regen_report.py",
      description: "Regenerate audit report",
      run_in_background: true,
    }),
    toolResult(
      "t13",
      "Command running in background with ID: beecec7d. Output is being written to: /tmp/claude/tasks/beecec7d.output"
    ),
    toolUse("t14", "TaskOutput", {
      task_id: "beecec7d",
      block: true,
      timeout: 600000,
    }),
    toolResult(
      "t14",
      "<retrieval_status>success</retrieval_status>\n<task_id>beecec7d</task_id>\n<task_type>local_bash</task_type>\n<status>completed</status>\n<exit_code>0</exit_code>\n<output>report.md written</output>"
    ),
    toolUse("t15", "Bash", {
      command: 'git commit -am "fix: filter inactive source bindings"',
      description: "Commit the fix",
    }),
    toolResult(
      "t15",
      "[audit-followup 3f2a91c] fix: filter inactive source bindings\n 2 files changed, 4 insertions(+), 2 deletions(-)"
    ),
    {
      type: "text",
      text: [
        "The web build is clean and the unit suite now passes 48/48.",
        "",
        "The failure came from `query_tasks.model_copy` copying inactive source bindings into the report. I filtered them where the tuple is built, and Codex updated the snapshot that encoded the old behavior.",
        "",
        "- `agent/src/hvac_agent/query_tasks.py` skips bindings where `active` is false",
        "- `web/lib/__fixtures__/tasks.json` snapshot updated by Codex",
        "",
        "Committed as `3f2a91c` on `audit-followup`. The regenerated report is at `.local/hvac-audit-followup-20261022/report.md`.",
      ].join("\n"),
    },
  ],
}

/** The same work caught mid-turn: a test command still running. */
export const MOCKUP_LIVE_TURN: MessageTurn = {
  id: "turn-live",
  role: "assistant",
  timestamp: "2026-10-22T08:10:00Z",
  blocks: [
    {
      type: "thinking",
      text: "**Checking the failing test**\n\nThe snapshot test still fails; look at the fixture first.",
    },
    toolUse("l1", "Read", {
      file_path: `${MOCKUP_REPO}/web/lib/__fixtures__/tasks.json`,
    }),
    toolResult("l1", fixtureLines(40, "tasks.json")),
    toolUse("l2", "Grep", { pattern: "inactive", path: "web/lib" }),
    toolResult(
      "l2",
      "web/lib/tasks.test.ts:58:    expect(mapBindings(fixture)).toHaveLength(2)"
    ),
    toolUse("l3", "Bash", {
      command: "pnpm --filter web test -- --watch=false",
      description: "Run web unit tests",
    }),
    toolResult(
      "l3",
      [
        "> web@0.1.0 test",
        "> vitest run",
        "",
        " RUN  v4.0.2 /Users/demo/hvac/web",
        "",
        " ✓ lib/report.test.ts (12 tests) 41ms",
        " ✓ lib/state.test.ts (9 tests) 22ms",
      ].join("\n")
    ),
  ],
}

export const MOCKUP_ADAPTER_TEXT = {
  attachedResources: "Attached",
  toolCallFailed: "Tool call failed",
  pageHandoffName: () => "page",
}
