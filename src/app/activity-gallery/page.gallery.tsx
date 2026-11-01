"use client"

/**
 * Activity timeline gallery — a development page, built only with
 * CODEG_GALLERY=1 (see `pageExtensions` in next.config.ts).
 *
 * Renders fixture replies through the real pipeline (`adaptMessageTurn` →
 * `CompletedTurnContent`), outside any workspace, so every step kind and state
 * can be looked at and screenshotted side by side: `?view=` picks a scenario
 * (default: all), `?lang=` sets the interface language.
 */

import { useEffect, useMemo, useState } from "react"

import { Message, MessageContent } from "@/components/ai-elements/message"
import { AsyncTaskStrip } from "@/components/chat/async-task-strip"
import { SessionDetailsInsights } from "@/components/layout/session-details-insights"
import { CompletedTurnContent } from "@/components/message/completed-turn-content"
import { ContentPartsRenderer } from "@/components/message/content-parts-renderer"
import { extractDelegationSources } from "@/components/message/message-list-view"
import { buildMessageNavEntries } from "@/components/message/message-nav-entries"
import { MessageNavScrollContext } from "@/components/message/message-nav-scroll-context"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  ActivityLiveProvider,
  type ActivityLiveValue,
} from "@/components/message/activity/activity-live-context"
import {
  StaticConnectionStoreProvider,
  type ConnectionStoreApi,
} from "@/contexts/acp-connections-context"
import {
  StaticDelegationProvider,
  type DelegationContextValue,
} from "@/contexts/delegation-context"
import {
  StaticWorkspaceActionsProvider,
  type WorkspaceActionsValue,
} from "@/contexts/workspace-context"
import { adaptMessageTurn } from "@/lib/adapters/ai-elements-adapter"
import {
  EMPTY_TOOL_APPROVALS,
  type ToolApprovalMap,
} from "@/lib/activity/approval"
import {
  fixtureLines,
  MOCKUP_ADAPTER_TEXT,
  MOCKUP_ASSISTANT_TURN,
  MOCKUP_LIVE_TURN,
  MOCKUP_REPO,
  MOCKUP_USER_TURN,
  toolResult,
  toolUse,
} from "@/lib/activity/__fixtures__/mockup-turn"
import type { AsyncTaskRecord, MessageTurn } from "@/lib/types"
import { publishTranscriptInsights } from "@/stores/transcript-insights-store"

const params =
  typeof window !== "undefined"
    ? new URLSearchParams(window.location.search)
    : new URLSearchParams()

if (typeof window !== "undefined") {
  // Outside a backend: answer the language lookup, swallow the rest.
  const lang = params.get("lang") ?? "en"
  const original = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    if (url.endsWith("/api/get_system_language_settings")) {
      return new Response(JSON.stringify({ mode: "manual", language: lang }))
    }
    if (url.includes("/api/")) return new Response(JSON.stringify(null))
    return original(input, init)
  }
}

const STORE: ConnectionStoreApi = {
  getConnection: () => undefined,
  getConnectPending: () => undefined,
  getConnectError: () => undefined,
  getActiveKey: () => null,
  subscribeKey: () => () => {},
  subscribeActiveKey: () => () => {},
}

const DELEGATION: DelegationContextValue = {
  findByParentToolUseId: () => undefined,
  findByChildConversationId: () => undefined,
  findByTaskId: () => undefined,
}

const WORKSPACE = new Proxy(
  {},
  { get: () => () => {} }
) as unknown as WorkspaceActionsValue

const FAILURE_TURN: MessageTurn = {
  id: "turn-failure",
  role: "assistant",
  timestamp: "2026-10-22T09:00:00Z",
  duration_ms: 41000,
  blocks: [
    toolUse("f1", "Bash", { command: "pnpm --filter web build" }),
    toolResult(
      "f1",
      [
        "> web@0.1.0 build",
        "> next build",
        "",
        "Failed to compile.",
        "",
        "./lib/tasks.ts:12:7",
        "Type error: Property 'active' does not exist on type 'Binding'.",
        "",
        "[terminal exited: exit code: 1]",
      ].join("\n"),
      true
    ),
    toolUse("f2", "mcp__github__create_pull_request", {
      title: "Filter inactive bindings",
      head: "audit-followup",
    }),
    toolResult(
      "f2",
      JSON.stringify({ result: null, error: "GitHub API rate limit exceeded" }),
      true
    ),
    toolUse("f3", "Edit", {
      file_path: `${MOCKUP_REPO}/web/lib/tasks.ts`,
      old_string: "binding.active",
      new_string: "binding.isActive",
    }),
    toolResult(
      "f3",
      "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).",
      true
    ),
    {
      type: "text",
      text: "The build fails on a type error and I could not open the pull request.",
    },
  ],
}

/** Commands that exited non-zero: some answered what they asked (a search that
 *  found nothing, a test that came out false, a name or a path that is not
 *  there, files that differ), some failed — one with a code that names why. */
const EXITS_TURN: MessageTurn = {
  id: "turn-exits",
  role: "assistant",
  timestamp: "2026-10-22T09:01:00Z",
  duration_ms: 132000,
  blocks: [
    toolUse("x1", "Bash", { command: "rg -n 'source_bindings' web/lib" }),
    toolResult("x1", "Exit code 1", true),
    toolUse("x2", "Bash", { command: "test -f .env.local && echo present" }),
    toolResult("x2", "Exit code 1", true),
    toolUse("x3", "Bash", { command: "which python2" }),
    toolResult("x3", "Exit code 1\npython2 not found", true),
    toolUse("x4", "Bash", { command: "cat web/.env.example" }),
    toolResult(
      "x4",
      "Exit code 1\ncat: web/.env.example: No such file or directory",
      true
    ),
    toolUse("x5", "Bash", { command: "git diff --quiet -- web" }),
    toolResult("x5", "Exit code 1", true),
    {
      type: "text",
      text: "No `.env.local` and nothing reads `source_bindings` in `web/lib`; the web tree has uncommitted changes.",
    },
    toolUse("x6", "Bash", { command: "pyhton scripts/regen_report.py" }),
    toolResult(
      "x6",
      "Exit code 127\n(eval):1: command not found: pyhton",
      true
    ),
    toolUse("x7", "Bash", {
      command: "pnpm --filter web test",
      description: "Run web unit tests",
    }),
    toolResult(
      "x7",
      [
        "FAIL  lib/report.test.ts > maps inactive bindings",
        "",
        "Tests: 1 failed, 47 passed, 48 total",
        "",
        "Exit code 1",
      ].join("\n"),
      true
    ),
    toolUse("x8", "Bash", { command: "node scripts/crawl-audit.js" }),
    toolResult("x8", "Exit code 143\nCommand timed out after 2m 0s", true),
    {
      type: "text",
      text: "The test run still fails one case, and the crawl timed out.",
    },
  ],
}

/** A reply that is all process: prose first, then a call that failed, and no
 *  answer after it — the header cannot fold it away. */
const NO_ANSWER_TURN: MessageTurn = {
  id: "turn-no-answer",
  role: "assistant",
  timestamp: "2026-10-22T09:02:00Z",
  duration_ms: 9000,
  blocks: [
    { type: "text", text: "Checking the build before I change anything." },
    toolUse("n1", "Bash", { command: "pnpm --filter web build" }),
    toolResult(
      "n1",
      [
        "> web@0.1.0 build",
        "> next build",
        "",
        "Failed to compile.",
        "",
        "[terminal exited: exit code: 1]",
      ].join("\n"),
      true
    ),
  ],
}

const CODEX_TURN: MessageTurn = {
  id: "turn-codex",
  role: "assistant",
  timestamp: "2026-10-22T09:10:00Z",
  duration_ms: 96000,
  blocks: [
    {
      type: "thinking",
      text: "**Locating the report writer**\n\nThe regen script writes report.md; check how it orders bindings.",
    },
    toolUse("c1", "exec_command", {
      cmd: ["bash", "-lc", "rg -n 'def write_report' agent/src"],
    }),
    toolResult(
      "c1",
      JSON.stringify({
        formatted_output:
          "agent/src/hvac_agent/report.py:31:def write_report(tasks, path):",
        exit_code: 0,
      })
    ),
    toolUse("c2", "Read", {
      file_path: `${MOCKUP_REPO}/agent/src/hvac_agent/report.py`,
    }),
    toolResult("c2", fixtureLines(64, "report.py")),
    toolUse("c3", "grep", { pattern: "legacy_binding", path: "agent/src" }),
    toolResult("c3", ""),
    toolUse(
      "c4",
      "apply_patch",
      [
        "*** Begin Patch",
        "*** Update File: agent/src/hvac_agent/report.py",
        "@@ def write_report(tasks, path):",
        "-    for b in task.source_bindings:",
        "+    for b in sorted(task.source_bindings, key=lambda b: b.id):",
        "*** Add File: agent/src/hvac_agent/report_test.py",
        "+from hvac_agent.report import write_report",
        "+",
        "+def test_sorted():",
        "+    assert True",
        "*** End Patch",
      ].join("\n")
    ),
    toolResult(
      "c4",
      "Success. Updated the following files:\nM report.py\nA report_test.py"
    ),
    toolUse("c5", "exec_command", {
      cmd: ["bash", "-lc", "cd agent && .venv/bin/pytest -q"],
    }),
    toolResult(
      "c5",
      "Chunk ID: 8f2a\nWall time: 14.2 seconds\nProcess exited with code 0\nOutput:\n\u001b[32m....\u001b[0m\n4 passed in 13.87s"
    ),
    toolUse("c6", "wait", {
      cell_id: "7106",
      session_command: "bash -lc 'pnpm dev'",
    }),
    toolResult("c6", "ready - started server on 0.0.0.0:3000"),
    { type: "text", text: "Sorted the bindings and added a test." },
  ],
}

const AGENT_TURN: MessageTurn = {
  id: "turn-agent",
  role: "assistant",
  timestamp: "2026-10-22T09:20:00Z",
  duration_ms: 61000,
  blocks: [
    toolUse("a1", "Agent", {
      description: "Find binding consumers",
      prompt:
        "Find every consumer of source_bindings in the agent package and report which ones assume inactive bindings are present.",
      subagent_type: "Explore",
    }),
    {
      type: "tool_result",
      tool_use_id: "a1",
      is_error: false,
      output_preview:
        "Three consumers read `source_bindings`; only `report.py` assumes inactive bindings are present.",
      agent_stats: {
        agent_type: "Explore",
        status: "completed",
        total_duration_ms: 48000,
        total_tokens: 18400,
        total_tool_use_count: 2,
        read_count: 1,
        search_count: 1,
        tool_calls: [
          {
            tool_name: "Grep",
            input_preview: JSON.stringify({ pattern: "source_bindings" }),
            output_preview: "4 matches",
            is_error: false,
          },
          {
            tool_name: "Read",
            input_preview: JSON.stringify({
              file_path: `${MOCKUP_REPO}/agent/src/hvac_agent/report.py`,
            }),
            output_preview: fixtureLines(30, "report.py"),
            is_error: false,
          },
        ],
        timeline: [
          {
            type: "text",
            text: "I'll find every reader of `source_bindings` first.",
          },
          { type: "tool_call", childIndex: 0 },
          {
            type: "text",
            text: "Four matches; only `report.py` walks them directly, so I'll read it.",
          },
          { type: "tool_call", childIndex: 1 },
          {
            type: "text",
            text: "Three consumers read `source_bindings`; only `report.py` assumes inactive bindings are present.\n\n- `report.py` writes a line for every binding\n- `tasks.py` drops inactive bindings first\n- `audit.py` only counts them",
          },
        ],
      },
    },
    {
      type: "text",
      text: "Only `report.py` relies on inactive bindings being present.",
    },
  ],
}

const AGENT_LIVE_TURN: MessageTurn = {
  id: "turn-agent-live",
  role: "assistant",
  timestamp: "2026-10-22T09:25:00Z",
  blocks: [
    toolUse("a2", "Agent", {
      description: "Run the build",
      prompt:
        "Run `pnpm build` in /Users/me/work/my-app without changing any files, and report whether it succeeded with the exit code and the key output.",
      subagent_type: "general-purpose",
    }),
  ],
}

const WORKFLOW_TURN: MessageTurn = {
  id: "turn-workflow",
  role: "assistant",
  timestamp: "2026-10-22T09:40:00Z",
  duration_ms: 128000,
  blocks: [
    toolUse("w1", "TodoWrite", {
      todos: [
        { content: "Reproduce the report bug", status: "completed" },
        { content: "Filter inactive bindings", status: "in_progress" },
        { content: "Regenerate the audit report", status: "pending" },
      ],
    }),
    toolResult("w1", "Todos have been modified successfully."),
    toolUse("w2", "mcp__codeg-mcp__ask_user_question", {
      questions: [
        {
          question: "Which report format?",
          header: "Format",
          multiSelect: false,
          options: [
            { label: "Markdown (Recommended)", description: "Readable" },
            { label: "HTML", description: "Printable" },
          ],
        },
      ],
    }),
    toolResult(
      "w2",
      JSON.stringify({
        answers: [
          {
            header: "Format",
            question: "Which report format?",
            selected: ["Markdown (Recommended)"],
          },
        ],
        declined: false,
      })
    ),
    toolUse("w3", "mcp__codeg-mcp__check_user_feedback", {}),
    toolResult(
      "w3",
      '{"count":1,"feedback":[{"created_at":"2026-10-22T09:41:12Z","text":"Also keep the CSV export working"}]}'
    ),
    toolUse("w4", "mcp__codeg-mcp__task_progress", {
      message: "Bindings filtered; regenerating the report next",
    }),
    toolResult("w4", '{"recorded":true}'),
    toolUse("w5", "Bash", {
      command: "python scripts/export_csv.py",
      description: "Export CSV",
      run_in_background: true,
    }),
    toolResult(
      "w5",
      "Command running in background with ID: c0ffee12. Output is being written to: /tmp/claude/tasks/c0ffee12.output"
    ),
    toolUse("w6", "TaskOutput", { task_id: "c0ffee12", block: true }),
    toolResult(
      "w6",
      "<retrieval_status>success</retrieval_status>\n<task_id>c0ffee12</task_id>\n<task_type>local_bash</task_type>\n<status>completed</status>\n<exit_code>2</exit_code>\n<output>Traceback (most recent call last):\n  File \"scripts/export_csv.py\", line 9\nKeyError: 'active'</output>"
    ),
    toolUse("w7", "ExitPlanMode", {
      plan: "# Keep CSV export working\n\n1. Map `active` in the CSV writer\n2. Re-run the export\n3. Commit",
    }),
    toolResult("w7", "User has approved your plan."),
    { type: "text", text: "Plan approved — fixing the CSV writer next." },
  ],
}

const GLOBBED = [
  "lib/utils.ts",
  "components/validation-lab.tsx",
  "components/test-page-two.tsx",
  "components/demo-page.tsx",
  "components/test-lab.tsx",
  "components/cyberpunk-console.tsx",
  "components/experiment-console.tsx",
  "components/ui/input.tsx",
  "components/ui/textarea.tsx",
  "components/ui/button.tsx",
  "components/ui/card.tsx",
  "components/ui/dialog.tsx",
  "components/ui/select.tsx",
  "components/ui/tabs.tsx",
  "components/ui/tooltip.tsx",
  "hooks/use-mobile.ts",
  "hooks/use-toast.ts",
  "hooks/use-debounce.ts",
  "lib/format.ts",
].map((file) => `${MOCKUP_REPO}/web/${file}`)

const LAYOUT = `${MOCKUP_REPO}/web/app/layout.tsx`

const FILES_TURN: MessageTurn = {
  id: "turn-files",
  role: "assistant",
  timestamp: "2026-10-22T09:50:00Z",
  duration_ms: 52000,
  blocks: [
    {
      type: "thinking",
      text: "**Mapping the components**\n\nList the components first.\nThen read the layout's navigation.\nThen add the settings page and link it.",
    },
    toolUse("g1", "Glob", { pattern: "{lib,hooks,components}/**/*.{ts,tsx}" }),
    toolResult("g1", GLOBBED.join("\n")),
    toolUse("r1", "Read", { file_path: LAYOUT, offset: 10, limit: 6 }),
    toolResult(
      "r1",
      JSON.stringify({
        start_line: 10,
        content: [
          "export default function RootLayout({ children }) {",
          "  return (",
          '    <html lang="en">',
          "      <body>",
          '        <nav><a href="/">Home</a></nav>',
          "        {children}",
        ].join("\n"),
      })
    ),
    toolUse("w1", "Write", {
      file_path: `${MOCKUP_REPO}/web/app/settings/page.tsx`,
      content:
        "export default function SettingsPage() {\n  return <main>Settings</main>\n}\n",
    }),
    toolResult(
      "w1",
      `File created successfully at: ${MOCKUP_REPO}/web/app/settings/page.tsx`
    ),
    toolUse("e1", "Edit", {
      file_path: LAYOUT,
      old_string: '        <nav><a href="/">Home</a></nav>',
      new_string:
        '        <nav>\n          <a href="/">Home</a>\n          <a href="/settings">Settings</a>\n        </nav>',
    }),
    toolResult("e1", `The file ${LAYOUT} has been updated successfully.`),
    {
      type: "text",
      text: "Added the settings page and linked it from the navigation.",
    },
  ],
}

/** An edit taller than its panel, with lines wider than it: the panel scrolls
 *  both ways, in the inline and the side-by-side view. */
const LONG_EDIT_OLD = [
  "export async function loadTasks(client: ApiClient, folder: string) {",
  "  const response = await client.get(`/folders/${encodeURIComponent(folder)}/tasks?include=bindings,assignees,labels&state=open`)",
  "  const tasks = response.data.tasks",
  "  return tasks.filter((task) => task.binding.active)",
  "}",
]
const LONG_EDIT_NEW = [
  "export async function loadTasks(",
  "  client: ApiClient,",
  "  folder: string,",
  "  { includeInactive = false, signal }: LoadTasksOptions = {}",
  ") {",
  "  const query = new URLSearchParams({ include: 'bindings,assignees,labels', state: 'open', page_size: String(TASK_PAGE_SIZE) })",
  "  const tasks: Task[] = []",
  "  for (let page = 1; ; page += 1) {",
  "    query.set('page', String(page))",
  "    const response = await client.get(`/folders/${encodeURIComponent(folder)}/tasks?${query}`, { signal })",
  "    tasks.push(...response.data.tasks)",
  "    if (!response.data.next_page) break",
  "  }",
  "  // A binding the server marks `is_active: false` belongs to a task that was moved to another folder; keep it only on request.",
  "  return includeInactive",
  "    ? tasks",
  "    : tasks.filter((task) => task.bindings.some((binding) => binding.isActive))",
  "}",
]
const LONG_EDIT_TURN: MessageTurn = {
  id: "turn-long-edit",
  role: "assistant",
  timestamp: "2026-10-22T09:55:00Z",
  duration_ms: 12000,
  blocks: [
    toolUse("le1", "Edit", {
      file_path: `${MOCKUP_REPO}/web/lib/tasks.ts`,
      old_string: LONG_EDIT_OLD.join("\n"),
      new_string: LONG_EDIT_NEW.join("\n"),
    }),
    toolResult(
      "le1",
      `The file ${MOCKUP_REPO}/web/lib/tasks.ts has been updated successfully.`
    ),
    { type: "text", text: "Tasks now load page by page." },
  ],
}

/** Codex scripts the history parser could not take apart: one with a long
 *  output, one that failed, one that printed nothing. */
const CODEX_SCRIPT_SOURCE = [
  "const cmds = [",
  '  "git show 71be0b15:src/components/browser/browser-page-handoff.tsx",',
  '  "git show ef1c3766:src/components/browser/browser-page-handoff.tsx",',
  "  \"nl -ba src/components/browser/browser-screenshot-markup.tsx | sed -n '1,100p;430,520p'\",",
  "  \"nl -ba src/components/browser/browser-page-handoff.test.tsx | sed -n '1,260p;455,565p'\"",
  "];",
  'const results = await Promise.allSettled(cmds.map(cmd => tools.exec_command({cmd, workdir:"/Users/dev/work/codeg", max_output_tokens: 12000})));',
  'results.forEach((r,i) => text(JSON.stringify({cmd:cmds[i], result:r.status==="fulfilled"?r.value:String(r.reason)})));',
  "",
].join("\n")
const CODEX_SCRIPT_RESULT = (cmd: string) =>
  JSON.stringify({
    cmd,
    result: {
      output: Array.from(
        { length: 24 },
        (_, i) =>
          `${String(i + 1).padStart(4)}\timport { useBrowserPageHandoff } from "./browser-page-handoff" // line ${i + 1}`
      ).join("\n"),
      exit_code: 0,
    },
  })
const CODEX_SCRIPT_TURN: MessageTurn = {
  id: "turn-codex-script",
  role: "assistant",
  timestamp: "2026-10-22T09:58:00Z",
  duration_ms: 31000,
  blocks: [
    toolUse("cs1", "codex_script", {
      source: CODEX_SCRIPT_SOURCE,
      title:
        "git show 71be0b15:src/components/browser/browser-page-handoff.tsx",
      call_count: 1,
    }),
    toolResult(
      "cs1",
      [
        "Warning: truncated output (original token count: 11720)",
        "Total output lines: 4",
        "",
        CODEX_SCRIPT_RESULT(
          "git show 71be0b15:src/components/browser/browser-page-handoff.tsx"
        ),
        CODEX_SCRIPT_RESULT(
          "git show ef1c3766:src/components/browser/browser-page-handoff.tsx"
        ),
        CODEX_SCRIPT_RESULT(
          "nl -ba src/components/browser/browser-screenshot-markup.tsx | sed -n '1,100p;430,520p'"
        ),
      ].join("\n")
    ),
    toolUse("cs2", "codex_script", {
      source: [
        "const dirs = ['web', 'agent'];",
        "for (const dir of dirs) {",
        '  const r = await tools.exec_command({cmd: `pnpm --filter ${dir} test`, workdir: "/Users/dev/work/codeg"});',
        "  text(r.output);",
        "}",
      ].join("\n"),
      title: "pnpm --filter web test",
      call_count: 1,
    }),
    toolResult(
      "cs2",
      [
        ...Array.from(
          { length: 18 },
          (_, i) => ` ✓ lib/tasks-${i + 1}.test.ts (4 tests) ${12 + i}ms`
        ),
        "FAIL  lib/report.test.ts > writes bindings in id order",
        "AssertionError: expected [ 'b2', 'b1' ] to deeply equal [ 'b1', 'b2' ]",
        "Test Files  1 failed | 18 passed (19)",
        "     Tests  1 failed | 83 passed (84)",
      ].join("\n"),
      true
    ),
    toolUse("cs3", "codex_script", {
      source: [
        "const notes = ['report.md', 'CHANGELOG.md'];",
        "for (const n of notes)",
        '\ttext(`${n}: ${(await tools.exec_command({cmd: `wc -l ${n}`, workdir: "/Users/dev/work/codeg"})).output.trim()}`);',
      ].join("\n"),
      call_count: 1,
    }),
    toolResult("cs3", ""),
    { type: "text", text: "Compared the two versions of the handoff." },
  ],
}

const POLLED_TASK_ID = "9e82cbc1-5d0e-4f6a-8b3c-2a1d0e9f8c7b"
const POLLED_TASK =
  "Run `pnpm build` in /Users/me/work/my-app without changing any files. Report whether it succeeded (exit code), the key output, and — if it failed — the full error with file paths and line numbers."

const RUNNING_TASK_ID = "5b4a74be-2c1d-4e8f-9a0b-6c5d4e3f2a1b"
const RUNNING_TASK =
  "Run the web unit tests in /Users/me/work/my-app and report every failure with its file path and line number."

const DELEGATION_TURN: MessageTurn = {
  id: "turn-delegation",
  role: "assistant",
  timestamp: "2026-10-22T10:00:00Z",
  duration_ms: 64000,
  blocks: [
    toolUse(
      "d1",
      "mcp__codeg-mcp__delegate_to_agent",
      { agent_type: "codex", task: POLLED_TASK },
      {
        "codeg.delegation": {
          status: "completed",
          child_conversation_id: 78,
          task_id: POLLED_TASK_ID,
          task_preview: POLLED_TASK,
        },
      }
    ),
    toolResult(
      "d1",
      JSON.stringify({ task_id: POLLED_TASK_ID, status: "started" })
    ),
    {
      type: "text",
      text: "Codex is waiting for you to approve `pnpm build`; it will not go on until you confirm in Codeg. I'll keep waiting.",
    },
    toolUse("d2", "mcp__codeg-mcp__get_delegation_status", {
      task_ids: [POLLED_TASK_ID],
      wait_ms: 60000,
    }),
    toolResult(
      "d2",
      JSON.stringify({
        task_id: POLLED_TASK_ID,
        status: "completed",
        text: "pnpm build succeeded, exit code 0.",
        duration_ms: 42000,
      })
    ),
    {
      type: "plan",
      entries: [
        {
          content: "Survey the project layout",
          priority: "high",
          status: "completed",
        },
        {
          content: "Read the core entry points",
          priority: "high",
          status: "completed",
        },
        {
          content: "Run the existing tests",
          priority: "medium",
          status: "completed",
        },
        {
          content: "Design the new feature",
          priority: "medium",
          status: "in_progress",
        },
        {
          content: "Write the implementation",
          priority: "medium",
          status: "pending",
        },
        { content: "Add tests and verify", priority: "low", status: "pending" },
      ],
    },
    // Still out when the reply ends: no step and no word from it yet.
    toolUse(
      "d3",
      "mcp__codeg-mcp__delegate_to_agent",
      { agent_type: "codex", task: RUNNING_TASK },
      {
        "codeg.delegation": {
          status: "running",
          child_conversation_id: 79,
          task_id: RUNNING_TASK_ID,
          task_preview: RUNNING_TASK,
        },
      }
    ),
    toolResult(
      "d3",
      JSON.stringify({ task_id: RUNNING_TASK_ID, status: "started" })
    ),
    toolUse("d4", "mcp__codeg-mcp__get_delegation_status", {
      task_ids: [RUNNING_TASK_ID],
      wait_ms: 60000,
    }),
    toolResult(
      "d4",
      JSON.stringify({ task_id: RUNNING_TASK_ID, status: "running" })
    ),
    {
      type: "text",
      text: "The build passes; three of the six steps are done.",
    },
  ],
}

const TEXT_TURN: MessageTurn = {
  id: "turn-text",
  role: "assistant",
  timestamp: "2026-10-22T09:30:00Z",
  duration_ms: 3000,
  blocks: [{ type: "text", text: "Yes — the fix is already on `main`." }],
}

/** Commands run back to back, the last still running, none described. */
const COMMANDS_LIVE_TURN: MessageTurn = {
  id: "turn-commands-live",
  role: "assistant",
  timestamp: "2026-10-23T08:00:00Z",
  blocks: [
    { type: "text", text: "Writing the page, then checking it." },
    toolUse("k1", "Bash", {
      command: [
        "mkdir -p app/neon && cat > app/neon/page.tsx <<'EOF'",
        'import { NeonDemo } from "@/components/neon-demo"',
        "",
        "export default function Page() {",
        "  return <NeonDemo />",
        "}",
        "EOF",
      ].join("\n"),
    }),
    toolResult("k1", ""),
    toolUse("k2", "Bash", {
      command: [
        "npx eslint app/neon components/neon-demo.tsx && npx tsc --noEmit && echo OK",
        "(npx next dev -p 3917 >/dev/null 2>&1 &) ; sleep 8; curl -s -o /dev/null -w '%{http_code}' localhost:3917/neon",
      ].join("\n"),
    }),
    toolResult("k2", "OK\n200"),
    toolUse("k3", "Bash", {
      command: "pnpm --filter web test -- --watch=false",
    }),
    toolResult(
      "k3",
      [
        "> web@0.1.0 test",
        "> vitest run",
        "",
        " ✓ lib/report.test.ts (12 tests)",
      ].join("\n")
    ),
  ],
}

/** A command group the reply has gone on past, with one of its commands moved
 *  to the background and still running (codex's `asyncTasks.backgrounded`:
 *  the call that launched it never settles). */
const BACKGROUND_GROUP_TURN: MessageTurn = {
  id: "turn-background-group",
  role: "assistant",
  timestamp: "2026-10-29T08:00:00Z",
  blocks: [
    toolUse("bg1", "Bash", {
      command:
        "cat package.json && cat app/page.tsx && cat app/globals.css && cat components/neon-demo.tsx",
    }),
    toolResult("bg1", '{\n  "name": "web",\n  "private": true\n}'),
    toolUse(
      "bg2",
      "Bash",
      { command: "git status --short && find .. -name AGENTS.md -print" },
      { jetbrains: { air: { asyncTasks: { backgrounded: true } } } }
    ),
    toolResult(
      "bg2",
      [
        "../codeg-task-423/AGENTS.md",
        "../codeg-dev-0630/AGENTS.md",
        "find: ../.Trashes: Operation not permitted",
      ].join("\n")
    ),
    {
      type: "thinking",
      text: "**Considering design options**\n\nThe page needs a calmer palette.",
    },
  ],
}

/** Every Markdown block a reply carries, the wide ones wider than the column. */
const MARKDOWN_TURN: MessageTurn = {
  id: "turn-markdown",
  role: "assistant",
  timestamp: "2026-10-23T08:10:00Z",
  duration_ms: 9000,
  blocks: [
    {
      type: "thinking",
      text: [
        "**Planning the retry change**",
        "",
        "- read the settings first",
        "- then the wrapper",
        "",
        "1. timeout",
        "2. attempts",
      ].join("\n"),
    },
    {
      type: "text",
      text: [
        "The retry wrapper now backs off exponentially. What changed:",
        "",
        "- The timeout moved from a constant to the settings",
        "- Each attempt logs its delay, so a slow upstream shows in the trace",
        "  - the first retry waits 200 ms",
        "  - the wait doubles, up to 5 s",
        "- `lib/retry.ts` keeps its signature",
        "",
        "How a request goes now:",
        "",
        "1. Read the timeout from the settings",
        "2. Try, and on a failure wait before the next attempt",
        "3. Give up after five attempts and keep the last error",
        "",
        "Left to do:",
        "",
        "- [x] Move the timeout into the settings",
        "- [ ] Document the new option",
        "",
        "| Setting | Default | Range | Environment variable | Config path | What it does | Updated |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| `retry.timeoutMs` | 2000 | 100–60000 | `CODEG_RETRY_TIMEOUT_MS` | `network.retry.timeoutMs` | How long one attempt may take before it counts as failed | 2026-10-23T08:00:00Z |",
        "| `retry.attempts` | 5 | 1–10 | `CODEG_RETRY_ATTEMPTS` | `network.retry.attempts` | How many times a request is tried before it gives up | 2026-10-23T08:00:00Z |",
        "| `retry.maxDelayMs` | 5000 | 200–60000 | `CODEG_RETRY_MAX_DELAY_MS` | `network.retry.maxDelayMs` | The longest wait between two attempts | 2026-10-23T08:00:00Z |",
        "",
        "```ts",
        "export async function withRetry<T>(fn: () => Promise<T>, { attempts = 5, baseDelayMs = 200, maxDelayMs = 5_000 }: RetryOptions = {}): Promise<T> {",
        "  let lastError: unknown",
        "  for (let attempt = 0; attempt < attempts; attempt += 1) {",
        "    try {",
        "      return await fn()",
        "    } catch (error) {",
        "      lastError = error",
        "      await sleep(Math.min(baseDelayMs * 2 ** attempt, maxDelayMs))",
        "    }",
        "  }",
        "  throw lastError",
        "}",
        "```",
        "",
        "The log line, in a fence that names no language:",
        "",
        "```",
        "retry 2/5 after 400 ms: ECONNRESET",
        "```",
        "",
        "> The old constant is still exported for one release.",
      ].join("\n"),
    },
  ],
}

/**
 * A reply that streams in a step at a time (`?view=stream`), then settles and
 * starts over: prose that ends the reply and then turns into a note, a read,
 * commands that gather into a group one by one, an edit. `&interval=` sets the
 * beat in ms, `&beat=` holds it on one beat (`window.__setStreamBeat` moves
 * it). `&lead=prose` opens it on words rather than a thought, `&beats=` ends
 * it after that many (`&lead=prose&beats=1`: a reply of words alone), and
 * `&pending=1` draws its beat 0 as the pending reply, which gives way to the
 * reply as a send's does.
 */
const STREAM_BEATS: MessageTurn["blocks"][] = [
  [
    {
      type: "thinking",
      text: "**Looking at the page first**\n\nThen the styles it pulls in.",
    },
  ],
  [toolUse("s1", "Read", { file_path: `${MOCKUP_REPO}/web/app/page.tsx` })],
  [toolResult("s1", fixtureLines(30, "page.tsx"))],
  [{ type: "text", text: "The page imports the console. Checking it next." }],
  [toolUse("s2", "Bash", { command: "ls app components" })],
  [toolResult("s2", "app\ncomponents")],
  [toolUse("s3", "Bash", { command: "wc -l components/*.tsx" })],
  [toolResult("s3", "  120 components/cyberpunk-console.tsx")],
  [toolUse("s4", "Bash", { command: 'grep -n "keyframes" app/globals.css' })],
  [toolResult("s4", "12:@keyframes flicker {")],
  [{ type: "text", text: "Found it: the flicker runs on every frame." }],
  [
    toolUse("s5", "Edit", {
      file_path: `${MOCKUP_REPO}/web/app/globals.css`,
      old_string: "  animation: flicker 16ms infinite;",
      new_string: "  animation: flicker 1.6s infinite;",
      _start_line: 14,
    }),
  ],
  [
    toolResult(
      "s5",
      `The file ${MOCKUP_REPO}/web/app/globals.css has been updated successfully.`
    ),
  ],
  [toolUse("s6", "Bash", { command: "pnpm --filter web test" })],
  [toolResult("s6", " ✓ lib/report.test.ts (12 tests)")],
  [{ type: "text", text: "Done: the flicker now runs every 1.6 s." }],
]
/** Beats the settled reply stays up for before it starts over. */
const STREAM_SETTLED_BEATS = 3

/** The beats as the page asks for them (see `STREAM_BEATS`). */
const STREAM = ((): MessageTurn["blocks"][] => {
  const beats: MessageTurn["blocks"][] =
    params.get("lead") === "prose"
      ? [
          [
            {
              type: "text",
              text: "Looking at the page first, then its styles.",
            },
          ],
          ...STREAM_BEATS.slice(1),
        ]
      : STREAM_BEATS
  return beats.slice(0, Number(params.get("beats") ?? beats.length))
})()

function StreamScenario() {
  const interval = Number(params.get("interval") ?? 1400)
  const held = params.get("beat")
  const [beat, setBeat] = useState(held ? Number(held) : 1)
  useEffect(() => {
    // A probe steps a held reply itself.
    Object.assign(window, { __setStreamBeat: setBeat })
    if (held) return
    const id = window.setInterval(
      () =>
        setBeat((b) => (b >= STREAM.length + STREAM_SETTLED_BEATS ? 1 : b + 1)),
      interval
    )
    return () => window.clearInterval(id)
  }, [held, interval])
  const pending = params.get("pending") === "1" && beat === 0
  const scenario = useMemo<Scenario>(() => {
    const blocks = STREAM.slice(0, beat).flat()
    const answered = new Set(
      blocks.flatMap((b) =>
        b.type === "tool_result" && b.tool_use_id ? [b.tool_use_id] : []
      )
    )
    return {
      id: "stream",
      title: "Streaming, a step at a time",
      turn: {
        id: "turn-stream",
        role: "assistant",
        timestamp: "2026-10-23T09:00:00Z",
        duration_ms: 21000,
        blocks,
      },
      live: beat <= STREAM.length,
      inProgress: blocks.flatMap((b) =>
        b.type === "tool_use" && b.tool_use_id && !answered.has(b.tool_use_id)
          ? [b.tool_use_id]
          : []
      ),
    }
  }, [beat])
  // Two replies, as in the thread: the pending one goes, the reply comes.
  return (
    <ScenarioView
      key={pending ? "pending" : "reply"}
      scenario={scenario}
      pending={pending}
    />
  )
}

/**
 * The strip of background tasks over the transcript (`?view=async-tasks`):
 * `&tasks=` of them still running (default 6) — shells with an output and a
 * stop, a monitor that offers neither, a workflow on a phase, a turn the agent
 * started on its own — over the reference reply, in a pane as tall as a chat
 * column (`&height=`, default 640).
 */
const ASYNC_TASK_KINDS: AsyncTaskRecord[] = [
  {
    task_id: "bg-loops",
    name: "Run fixed-file loops then original-failure checks",
    task_type: "shell",
    description: "for f in $(cat fixed.txt); do pnpm vitest run $f; done",
    show_in_transcript: false,
    can_stop: true,
    state: "running",
    output_file_path: "/tmp/codeg-gallery/bg-loops.output",
  },
  {
    task_id: "bg-monitor",
    name: "t3 verification: fixed-run failures, original-failure tallies, completion",
    task_type: "monitor",
    description: "t3 verification",
    show_in_transcript: true,
    can_stop: false,
    state: "running",
  },
  {
    task_id: "bg-wait",
    name: "Wait until fixed-file verification loops finish",
    task_type: "shell",
    description: "until [ -f done.flag ]; do sleep 5; done",
    show_in_transcript: false,
    can_stop: true,
    state: "running",
    output_file_path: "/tmp/codeg-gallery/bg-wait.output",
  },
  {
    task_id: "bg-workflow",
    name: "deep-research",
    task_type: "workflow",
    description: "Survey the runners",
    show_in_transcript: true,
    can_stop: true,
    state: "running",
    phase: "Research",
    current_agent: "researcher-2",
  },
  {
    task_id: "bg-turn",
    name: "Claude is working",
    task_type: "turn",
    description: 'Background command "pnpm build" completed (exit code 0)',
    show_in_transcript: false,
    can_stop: true,
    state: "running",
  },
  {
    task_id: "bg-paused",
    name: "Wait until the whole verification job finishes",
    task_type: "shell",
    description: "wait $(cat job.pid)",
    show_in_transcript: false,
    can_stop: true,
    state: "paused",
    output_file_path: "/tmp/codeg-gallery/bg-paused.output",
  },
]

function AsyncTasksScenario() {
  const count = Number(params.get("tasks") ?? 6)
  const height = Number(params.get("height") ?? 640)
  const tasks = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => {
        const kind = ASYNC_TASK_KINDS[i % ASYNC_TASK_KINDS.length]!
        return { ...kind, task_id: `${kind.task_id}-${i}` }
      }),
    [count]
  )
  const reply = useMemo(
    () => adaptMessageTurn(MOCKUP_ASSISTANT_TURN, MOCKUP_ADAPTER_TEXT),
    []
  )
  const [roundOpen, setRoundOpen] = useState(false)
  return (
    <div
      id="gallery-root"
      data-scenario="async-tasks"
      className="mx-auto flex w-full max-w-[48rem] flex-col overflow-hidden border-x border-border"
      style={{ height }}
    >
      <AsyncTaskStrip
        tasks={tasks}
        onStop={async () => true}
        agentName="Claude Code"
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <Message from="assistant">
          <MessageContent>
            <CompletedTurnContent
              parts={reply.content}
              durationMs={MOCKUP_ASSISTANT_TURN.duration_ms}
              completed
              currentRound
              roundOpen={roundOpen}
              onRoundOpenChange={setRoundOpen}
            />
          </MessageContent>
        </Message>
      </div>
    </div>
  )
}

/**
 * The Session Details panel's message navigator (`?view=nav`), fed the replies
 * above as the rounds of one conversation: the last — two sub-agents, and
 * files written, edited and patched — open, as the panel opens the latest.
 * `&width=` sets the panel's width (default 348, the panel's own), `&height=`
 * its height (default the window's), `&current=` the message the transcript
 * shows (default the last).
 */
const NAV_CONVERSATION_ID = -1

function navUserTurn(id: string, text: string): MessageTurn {
  return {
    id,
    role: "user",
    timestamp: "2026-10-22T08:00:00Z",
    blocks: [{ type: "text", text }],
  }
}

const NAV_TURNS: MessageTurn[] = [
  navUserTurn("nav-1", "Survey the project and list its components"),
  FILES_TURN,
  navUserTurn("nav-2", "/compact"),
  navUserTurn(
    "nav-3",
    "Page through the tasks instead of loading them all at once"
  ),
  LONG_EDIT_TURN,
  navUserTurn(
    "nav-4",
    "继续打磨优化会话详情tab内容：\n1、Git分支名的左边那个图标不要；\n2、检查消息导航是否有性能问题，有的话一并修掉，然后跑一遍测试"
  ),
  DELEGATION_TURN,
  { ...FILES_TURN, id: "nav-files" },
  { ...LONG_EDIT_TURN, id: "nav-long-edit" },
  { ...CODEX_TURN, id: "nav-codex" },
]

function navInsights() {
  const threadIndexByTurnId = new Map(
    NAV_TURNS.flatMap((turn, index) =>
      turn.role === "user" ? [[turn.id, index] as const] : []
    )
  )
  const entries = buildMessageNavEntries({
    earlierTurns: null,
    earlierUserCount: 0,
    loadedTurns: NAV_TURNS,
    threadIndexByTurnId,
    loadedSubAgents: {
      byUserTurnId: new Map([
        [
          "nav-4",
          extractDelegationSources(
            adaptMessageTurn(DELEGATION_TURN, MOCKUP_ADAPTER_TEXT).content
          ),
        ],
      ]),
      leading: [],
    },
  })
  const plan = DELEGATION_TURN.blocks.find((block) => block.type === "plan")
  return {
    nav: {
      count: entries.length,
      entries,
      earlier: null,
      revealingTurnId: null,
      currentTurnId: params.get("current") ?? "nav-4",
    },
    plan: {
      entries: plan?.type === "plan" ? plan.entries : [],
      streaming: false,
    },
    actions: { selectNavEntry: () => {}, retryEarlierNav: () => {} },
  }
}

function NavScenario() {
  // Published before the first render reads it.
  useState(() =>
    publishTranscriptInsights(NAV_CONVERSATION_ID, "gallery", navInsights())
  )
  // As the Session Details tab hosts it: one scroll area, whose viewport the
  // navigator renders its rows in view of.
  const [viewport, setViewport] = useState<HTMLElement | null>(null)
  const height = params.get("height")
  return (
    <div
      data-scenario="nav"
      className="ws-surface ms-auto flex h-screen flex-col border-s border-border ws-chrome-border"
      style={{
        width: Number(params.get("width") ?? 348),
        height: height ? Number(height) : undefined,
      }}
    >
      <ScrollArea className="min-h-0 flex-1" onViewportRef={setViewport}>
        <MessageNavScrollContext.Provider value={viewport}>
          <div className="min-w-0 space-y-4 p-3 text-sm">
            <SessionDetailsInsights
              conversationId={NAV_CONVERSATION_ID}
              active
            />
          </div>
        </MessageNavScrollContext.Provider>
      </ScrollArea>
    </div>
  )
}

type Scenario = {
  id: string
  title: string
  turn: MessageTurn
  live?: boolean
  inProgress?: string[]
  /** The connection's answered permission requests, by tool call id. */
  approvals?: ToolApprovalMap
}

const MAIN_APPROVALS: ToolApprovalMap = {
  t13: {
    tool_call_id: "t13",
    option_kind: "allow_always",
    option_name: "Yes, and don't ask again for python commands",
    origin: "user",
    decided_at: "2026-10-22T09:44:02Z",
  },
  t15: {
    tool_call_id: "t15",
    option_kind: "allow_once",
    option_name: "Yes",
    origin: "chat_channel",
    decided_at: "2026-10-22T09:46:30Z",
  },
}

const SCENARIOS: Scenario[] = [
  {
    id: "main",
    title: "Reference turn",
    turn: MOCKUP_ASSISTANT_TURN,
    approvals: MAIN_APPROVALS,
  },
  {
    id: "live",
    title: "Live turn",
    turn: MOCKUP_LIVE_TURN,
    live: true,
    inProgress: ["l3"],
  },
  { id: "failure", title: "Failures", turn: FAILURE_TURN },
  { id: "exits", title: "Exit codes", turn: EXITS_TURN },
  { id: "no-answer", title: "Stopped on a failed call", turn: NO_ANSWER_TURN },
  { id: "codex", title: "Codex", turn: CODEX_TURN },
  { id: "agent", title: "Sub-agent", turn: AGENT_TURN },
  {
    id: "agent-live",
    title: "Sub-agent, running",
    turn: AGENT_LIVE_TURN,
    live: true,
    inProgress: ["a2"],
  },
  { id: "workflow", title: "Plans, questions and tasks", turn: WORKFLOW_TURN },
  { id: "delegation", title: "Delegation checks", turn: DELEGATION_TURN },
  { id: "files", title: "Files: match, read, write, edit", turn: FILES_TURN },
  { id: "long-edit", title: "A long edit", turn: LONG_EDIT_TURN },
  { id: "codex-script", title: "Codex scripts", turn: CODEX_SCRIPT_TURN },
  { id: "text", title: "Text-only reply", turn: TEXT_TURN },
  {
    id: "commands-live",
    title: "Commands back to back, running",
    turn: COMMANDS_LIVE_TURN,
    live: true,
    inProgress: ["k3"],
  },
  {
    id: "background-group",
    title: "A command moved to the background, the reply gone on past it",
    turn: BACKGROUND_GROUP_TURN,
    live: true,
    inProgress: ["bg2"],
  },
  { id: "markdown", title: "Markdown", turn: MARKDOWN_TURN },
]

function ScenarioView({
  scenario,
  pending = false,
}: {
  scenario: Scenario
  /** Drawn as the pending reply (see `CompletedTurnContent`). */
  pending?: boolean
}) {
  const [roundOpen, setRoundOpen] = useState(true)
  const adapted = useMemo(
    () =>
      adaptMessageTurn(
        scenario.turn,
        MOCKUP_ADAPTER_TEXT,
        scenario.live ?? false,
        scenario.inProgress ? new Set(scenario.inProgress) : undefined
      ),
    [scenario]
  )
  const live = useMemo<ActivityLiveValue>(
    () => ({
      awaitingToolCallId: null,
      awaitingUser: false,
      approvals: scenario.approvals ?? EMPTY_TOOL_APPROVALS,
    }),
    [scenario]
  )
  return (
    <section data-scenario={scenario.id} className="space-y-3">
      <h2 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
        {scenario.title}
      </h2>
      <ActivityLiveProvider value={live}>
        <Message from="assistant">
          <MessageContent>
            <CompletedTurnContent
              parts={adapted.content}
              durationMs={scenario.turn.duration_ms}
              completed={!scenario.live}
              currentRound
              roundOpen={roundOpen}
              onRoundOpenChange={setRoundOpen}
              pending={pending}
            />
          </MessageContent>
        </Message>
      </ActivityLiveProvider>
    </section>
  )
}

export default function ActivityGalleryPage() {
  const view = params.get("view") ?? "all"
  const user = useMemo(
    () => adaptMessageTurn(MOCKUP_USER_TURN, MOCKUP_ADAPTER_TEXT),
    []
  )
  const scenarios =
    view === "all" ? SCENARIOS : SCENARIOS.filter((s) => s.id === view)
  return (
    <StaticConnectionStoreProvider store={STORE}>
      <StaticDelegationProvider value={DELEGATION}>
        <StaticWorkspaceActionsProvider value={WORKSPACE}>
          <div className="chat-motion-scope min-h-screen bg-background text-foreground">
            {view === "nav" ? (
              <NavScenario />
            ) : view === "async-tasks" ? (
              <AsyncTasksScenario />
            ) : (
              <div
                id="gallery-root"
                className="mx-auto flex w-full max-w-[48rem] flex-col gap-8 px-6 py-8"
              >
                <Message from="user">
                  <MessageContent>
                    <ContentPartsRenderer parts={user.content} role="user" />
                  </MessageContent>
                </Message>
                {view === "stream" ? (
                  <StreamScenario />
                ) : (
                  scenarios.map((scenario) => (
                    <ScenarioView key={scenario.id} scenario={scenario} />
                  ))
                )}
              </div>
            )}
          </div>
        </StaticWorkspaceActionsProvider>
      </StaticDelegationProvider>
    </StaticConnectionStoreProvider>
  )
}
