import { describe, expect, it } from "vitest"

import {
  buildBackgroundTaskRows,
  isBackgroundTaskToolCall,
  parseBackgroundLaunch,
  parseBackgroundTaskEnvelope,
  parseBackgroundTaskEnvelopes,
  stripGrokSubagentScaffolding,
} from "@/lib/background-task"
import type { AdaptedToolCallPart } from "@/lib/adapters/ai-elements-adapter"

const COMPLETED = `<retrieval_status>success</retrieval_status>

<task_id>bfb5xnq1t</task_id>

<task_type>local_bash</task_type>

<status>completed</status>

<exit_code>0</exit_code>

<output>
running 0 tests
test result: ok. 0 passed
</output>`

const RUNNING = `<retrieval_status>timeout</retrieval_status>

<task_id>bfb5xnq1t</task_id>

<task_type>local_bash</task_type>

<status>running</status>`

const FAILED = `<retrieval_status>success</retrieval_status>

<task_id>bxx</task_id>

<task_type>local_bash</task_type>

<status>completed</status>

<exit_code>1</exit_code>

<output>error: build failed</output>`

const STOP_JSON = JSON.stringify({
  message: "Successfully stopped task: bebna5yf2 (cd /x; echo hi)",
  task_id: "bebna5yf2",
  task_type: "local_bash",
  command: "cd /x; echo hi",
})

const LAUNCH =
  "Command running in background with ID: be7lh91re. Output is being written to: /private/tmp/x/tasks/be7lh91re.output. You will be notified when it completes."

// Grok's shapes, captured from a real session (~/.grok/…/019fb314…): the launch
// acknowledgement, and the poll's JSON `TaskOutput` envelope.
const GROK_LAUNCH =
  "Background task term_b0d9512484964551a5bac4f82a805ae2 started"

const GROK_FAILED = JSON.stringify({
  type: "TaskOutput",
  Result: {
    task_id: "term_b0d",
    command: "/bin/bash -lc 'pnpm dev -- --port 3001'",
    status: "failed",
    exit_code: 1,
    started: "2026-07-30T12:52:48Z",
    ended: "2026-07-30T12:52:49Z",
    duration_secs: 0.787718,
    output:
      "$ next dev --turbopack -- --port 3001\nInvalid project directory provided, no such directory: /Users/me/proj/--port\n",
    truncated: false,
  },
})

const GROK_RUNNING = JSON.stringify({
  type: "TaskOutput",
  Result: {
    task_id: "term_273",
    command: "/bin/bash -lc 'pnpm exec next dev -p 3001'",
    status: "running",
    exit_code: null,
    output:
      "▲ Next.js 16.0.0\n- Local: http://localhost:3001\n✓ Ready in 1.2s\n",
  },
})

function poll(over: Partial<AdaptedToolCallPart> = {}): AdaptedToolCallPart {
  return {
    type: "tool-call",
    toolCallId: "c1",
    toolName: "TaskOutput",
    input: JSON.stringify({
      task_id: "bfb5xnq1t",
      block: true,
      timeout: 240000,
    }),
    output: COMPLETED,
    state: "output-available",
    ...over,
  }
}

/** A Grok `get_command_or_subagent_output` poll of the failed dev-server task. */
function grokPoll(
  over: Partial<AdaptedToolCallPart> = {}
): AdaptedToolCallPart {
  return poll({
    toolName: "get_command_or_subagent_output",
    input: JSON.stringify({ task_ids: ["term_b0d"], timeout_ms: 15000 }),
    output: GROK_FAILED,
    ...over,
  })
}

describe("parseBackgroundTaskEnvelope", () => {
  it("parses a completed poll envelope", () => {
    const env = parseBackgroundTaskEnvelope(COMPLETED)
    expect(env).not.toBeNull()
    expect(env!.kind).toBe("poll")
    expect(env!.taskId).toBe("bfb5xnq1t")
    expect(env!.taskType).toBe("local_bash")
    expect(env!.status).toBe("completed")
    expect(env!.exitCode).toBe(0)
    expect(env!.output).toContain("test result: ok")
  })

  it("parses a still-running poll (no exit code / output)", () => {
    const env = parseBackgroundTaskEnvelope(RUNNING)
    expect(env!.kind).toBe("poll")
    expect(env!.status).toBe("running")
    expect(env!.retrievalStatus).toBe("timeout")
    expect(env!.exitCode).toBeNull()
    expect(env!.output).toBeNull()
  })

  it("parses a non-zero exit code", () => {
    expect(parseBackgroundTaskEnvelope(FAILED)!.exitCode).toBe(1)
  })

  it("parses a TaskStop ack JSON", () => {
    const env = parseBackgroundTaskEnvelope(STOP_JSON)
    expect(env!.kind).toBe("stop")
    expect(env!.taskId).toBe("bebna5yf2")
    expect(env!.command).toBe("cd /x; echo hi")
    expect(env!.status).toBe("stopped")
  })

  it("returns null for unrelated text and for the launch notice", () => {
    expect(parseBackgroundTaskEnvelope("just some text")).toBeNull()
    expect(parseBackgroundTaskEnvelope(LAUNCH)).toBeNull()
    expect(
      parseBackgroundTaskEnvelope(JSON.stringify({ tasks: [] }))
    ).toBeNull()
    expect(parseBackgroundTaskEnvelope(null)).toBeNull()
  })

  it("keeps output containing angle brackets intact (greedy close)", () => {
    const env = parseBackgroundTaskEnvelope(
      `<retrieval_status>success</retrieval_status>\n<task_id>z</task_id>\n<status>completed</status>\n<exit_code>0</exit_code>\n<output>a <b> c </output>`
    )
    expect(env!.output).toBe("a <b> c ")
  })
})

describe("parseBackgroundLaunch", () => {
  it("extracts the task id from a background launch result", () => {
    expect(parseBackgroundLaunch(LAUNCH)).toEqual({ taskId: "be7lh91re" })
  })
  it("extracts the task id from Grok's launch acknowledgement", () => {
    expect(parseBackgroundLaunch(GROK_LAUNCH)).toEqual({
      taskId: "term_b0d9512484964551a5bac4f82a805ae2",
    })
  })
  it("returns null for non-launch text", () => {
    expect(parseBackgroundLaunch(COMPLETED)).toBeNull()
    expect(parseBackgroundLaunch(null)).toBeNull()
  })
})

describe("Grok TaskOutput envelopes", () => {
  it("parses a failed poll (command, exit code, output)", () => {
    const env = parseBackgroundTaskEnvelope(GROK_FAILED)
    expect(env).not.toBeNull()
    expect(env!.kind).toBe("poll")
    expect(env!.taskId).toBe("term_b0d")
    expect(env!.command).toBe("/bin/bash -lc 'pnpm dev -- --port 3001'")
    expect(env!.status).toBe("failed")
    expect(env!.exitCode).toBe(1)
    expect(env!.output).toContain("Invalid project directory")
  })

  it("parses a still-running poll", () => {
    const env = parseBackgroundTaskEnvelope(GROK_RUNNING)
    expect(env!.status).toBe("running")
    expect(env!.exitCode).toBeNull()
    expect(env!.output).toContain("Ready in")
  })

  it("expands a MultiResult into one envelope per task", () => {
    const envs = parseBackgroundTaskEnvelopes(
      JSON.stringify({
        type: "TaskOutput",
        MultiResult: {
          result_count: 2,
          results: [
            { task_id: "term_a", status: "completed", exit_code: 0 },
            { task_id: "term_b", status: "running" },
          ],
        },
      })
    )
    expect(envs.map((e) => e.taskId)).toEqual(["term_a", "term_b"])
  })

  it("maps a killed task to the stopped kind", () => {
    const env = parseBackgroundTaskEnvelope(
      JSON.stringify({
        type: "TaskOutput",
        Result: { task_id: "term_a", status: "killed", command: "sleep 900" },
      })
    )
    expect(env!.kind).toBe("stop")
  })

  it("ignores non-TaskOutput JSON, TaskNotFound, and truncated envelopes", () => {
    // A sub-agent poll of the SAME tool: different payload → generic rendering.
    expect(
      parseBackgroundTaskEnvelope(
        JSON.stringify({
          type: "SubagentCompleted",
          Result: { subagent_id: "s1", turns: 3 },
        })
      )
    ).toBeNull()
    expect(
      parseBackgroundTaskEnvelope(
        JSON.stringify({ type: "TaskOutput", TaskNotFound: { task_id: "x" } })
      )
    ).toBeNull()
    expect(
      parseBackgroundTaskEnvelope(GROK_FAILED.slice(0, GROK_FAILED.length - 20))
    ).toBeNull()
  })

  it("routes Grok polls into the background lane, sub-agent polls out of it", () => {
    // Settled poll → matched by its envelope.
    expect(isBackgroundTaskToolCall(grokPoll())).toBe(true)
    // In-flight poll → matched by `{task_ids, timeout_ms}` before any output.
    expect(
      isBackgroundTaskToolCall(
        grokPoll({ output: null, state: "input-available" })
      )
    ).toBe(true)
    // Same tool polling a sub-agent whose payload is an UNKNOWN shape (fields
    // nested under `Result` — not the flat 0.2.11x envelope): fail-safe out of
    // the lane. The real flat envelope now parses — see the
    // "SubagentCompleted" describe below.
    expect(
      isBackgroundTaskToolCall(
        grokPoll({
          output: JSON.stringify({
            type: "SubagentCompleted",
            Result: { subagent_id: "s1", turns: 3 },
          }),
        })
      )
    ).toBe(false)
    // …and it leaves the lane when a settled poll carries no output at all
    // (an older backend that dropped the envelope). Keying the input-shape
    // claim on "still in flight" (not on "has foreign output") is what stops
    // it from rendering as a permanently running background row.
    expect(
      isBackgroundTaskToolCall(
        grokPoll({ output: null, state: "output-available" })
      )
    ).toBe(false)
    expect(
      isBackgroundTaskToolCall(
        grokPoll({ output: null, state: "output-available", errorText: "" })
      )
    ).toBe(false)
  })

  it("keeps a live poll whose status has not settled yet", () => {
    // A promoted orphan: re-adapted with state output-available at COMPLETE_TURN
    // while its forwarded ACP status is still in_progress.
    expect(
      isBackgroundTaskToolCall(
        grokPoll({
          output: null,
          state: "output-available",
          toolStatus: "in_progress",
        })
      )
    ).toBe(true)
  })

  it("builds a failed row carrying the command and exit code", () => {
    const rows = buildBackgroundTaskRows([
      grokPoll({ toolCallId: "c1", output: null, state: "input-available" }),
      grokPoll({ toolCallId: "c2" }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].taskId).toBe("term_b0d")
    expect(rows[0].badge).toBe("failed")
    expect(rows[0].exitCode).toBe(1)
    expect(rows[0].command).toBe("/bin/bash -lc 'pnpm dev -- --port 3001'")
    expect(rows[0].output).toContain("Invalid project directory")
    expect(rows[0].pollCount).toBe(2)
  })

  it("marks a failure with no exit code as failed, not completed", () => {
    const rows = buildBackgroundTaskRows([
      grokPoll({
        output: JSON.stringify({
          type: "TaskOutput",
          Result: { task_id: "term_z", status: "failed", command: "x" },
        }),
      }),
    ])
    expect(rows[0].badge).toBe("failed")
  })
})

describe("Grok SubagentCompleted envelopes (0.2.11x sub-agent polls)", () => {
  // The flat shape the backend now passes through verbatim
  // (`parsers/grok.rs::grok_task_output_envelope`): fields sit directly on the
  // envelope, unlike `TaskOutput`'s nested `Result`. 0.2.9x instead folded
  // sub-agents into `TaskOutput.Result` with a `[subagent:<type>]` command —
  // parsing this restores that era's lane behavior.
  const SUBAGENT_DONE = JSON.stringify({
    type: "SubagentCompleted",
    subagent_id: "019f9432-e0d8-74c3-bd02-0772c4e04a65",
    subagent_type: "explore",
    description: "Explore test pages",
    status: "completed",
    tool_calls: 35,
    turns: 1,
    duration_ms: 63775,
    output: "## Codebase exploration summary",
  })

  it("parses the flat envelope into a sub-agent poll row", () => {
    const env = parseBackgroundTaskEnvelope(SUBAGENT_DONE)
    expect(env).not.toBeNull()
    expect(env!.kind).toBe("poll")
    expect(env!.taskId).toBe("019f9432-e0d8-74c3-bd02-0772c4e04a65")
    expect(env!.taskType).toBe("subagent")
    expect(env!.status).toBe("completed")
    expect(env!.command).toBe("[subagent:explore] Explore test pages")
    expect(env!.output).toBe("## Codebase exploration summary")
  })

  it("maps a cancelled sub-agent to the stopped kind", () => {
    const env = parseBackgroundTaskEnvelope(
      JSON.stringify({
        type: "SubagentCompleted",
        subagent_id: "s1",
        status: "cancelled",
      })
    )
    expect(env!.kind).toBe("stop")
  })

  it("rejects an empty envelope (nothing identifying)", () => {
    expect(
      parseBackgroundTaskEnvelope(JSON.stringify({ type: "SubagentCompleted" }))
    ).toBeNull()
  })

  it("routes a settled flat sub-agent poll into the background lane", () => {
    expect(isBackgroundTaskToolCall(grokPoll({ output: SUBAGENT_DONE }))).toBe(
      true
    )
    const rows = buildBackgroundTaskRows([grokPoll({ output: SUBAGENT_DONE })])
    expect(rows).toHaveLength(1)
    expect(rows[0].badge).toBe("completed")
    expect(rows[0].command).toBe("[subagent:explore] Explore test pages")
    expect(rows[0].isSubagent).toBe(true)
  })
})

describe("CodeBuddy TaskOutput snapshots", () => {
  // Verbatim shape from a real session (`~/.codebuddy/projects/…/<sid>.jsonl`):
  // a plain-text report, so neither the XML nor the JSON shape claimed it. The
  // `Response:` section repeats the `--- RESULT ---` body verbatim — only the
  // tail is shown.
  const CB_AGENT_DONE = `Task ID: agent-5af21a8e9ff04b19
Status: completed
Duration: 19s
Started: 2026-09-15T05:42:08.169Z
Ended: 2026-09-15T05:42:27.996Z
Agent Type: general-purpose
Task ID (for resume): agent-5af21a8e9ff04b19

Prompt:
Run the command \`pnpm build\` in /Users/xggz/my/my-app.

Response:
Build succeeded (exit code 0).

--- RESULT ---
Build succeeded (exit code 0).

**Summary:** Next.js 16.1.7 production build completed with no errors.`

  const CB_AGENT_RUNNING = `Task ID: agent-77
Status: running
Duration: 3s
Task ID (for resume): agent-77

--- RESULT ---
(no new progress since last check)

(Task still running. You will be notified automatically when it completes.)

<system-reminder data-role="tool-hint">
Agent agent-77 is still running. You will be automatically notified via a <task-notification> message when it finishes — do NOT poll TaskOutput in a loop.
</system-reminder>`

  const CB_SHELL = `Shell ID: bash-9
Command: pnpm dev
Status: completed
Duration: 2m 4s
Timestamp: 2026-09-15T05:42:27.996Z

Stdout (full):
ready on :3000

Stderr: (no output)`

  it("parses a completed agent snapshot into a sub-agent row", () => {
    const env = parseBackgroundTaskEnvelope(CB_AGENT_DONE)
    expect(env).not.toBeNull()
    expect(env!.kind).toBe("poll")
    expect(env!.taskId).toBe("agent-5af21a8e9ff04b19")
    expect(env!.taskType).toBe("subagent")
    expect(env!.status).toBe("completed")
    expect(env!.exitCode).toBeNull()
    expect(env!.output).toContain("Next.js 16.1.7 production build")
    // Only the RESULT tail — the header, the Prompt echo, and the duplicate
    // Response section stay out of the card.
    expect(env!.output).not.toContain("Task ID (for resume)")
    expect(env!.output).not.toContain("Response:")
    expect(env!.output).not.toContain("Prompt:")
  })

  it("strips the model-facing tool hint from a running snapshot", () => {
    const env = parseBackgroundTaskEnvelope(CB_AGENT_RUNNING)
    expect(env!.status).toBe("running")
    expect(env!.output).toContain("no new progress")
    expect(env!.output).not.toContain("system-reminder")
    expect(env!.output).not.toContain("do NOT poll TaskOutput")
  })

  it("maps a cancelled worker to the stopped kind", () => {
    const env = parseBackgroundTaskEnvelope(
      "Task ID: agent-9\nStatus: cancelled\n\n--- RESULT ---\n(Task was cancelled)"
    )
    expect(env!.kind).toBe("stop")
  })

  it("keeps a team-member snapshot's note (no RESULT separator)", () => {
    const env = parseBackgroundTaskEnvelope(
      "Task ID: agent-t\nStatus: running\n\nThis is a team member task (status: running). TaskOutput does not wait for teammates."
    )
    expect(env!.taskId).toBe("agent-t")
    expect(env!.output).toBe(
      "This is a team member task (status: running). TaskOutput does not wait for teammates."
    )
  })

  it("parses a background shell snapshot (command + stdout/stderr)", () => {
    const env = parseBackgroundTaskEnvelope(CB_SHELL)
    expect(env!.taskId).toBe("bash-9")
    expect(env!.taskType).toBe("local_bash")
    expect(env!.command).toBe("pnpm dev")
    expect(env!.status).toBe("completed")
    expect(env!.exitCode).toBeNull()
    expect(env!.output).toContain("ready on :3000")
    expect(env!.output).not.toContain("Duration:")
  })

  it("is not fooled by header labels echoed in the captured output", () => {
    // Shell output is arbitrary: a command can print lines the header is made
    // of. That is harmless as long as they don't form the whole five-line run.
    const SNAPSHOT = `Shell ID: bash-7
Command: ./emit-header.sh
Status: completed
Duration: 3s
Timestamp: 2026-09-15T05:42:27.996Z

Stdout (full):
Status: running
Duration: 99s
Timestamp: 2026-01-01T00:00:00.000Z
decoy

Stderr: (no output)`
    const env = parseBackgroundTaskEnvelope(SNAPSHOT)
    expect(env).not.toBeNull()
    expect(env!.command).toBe("./emit-header.sh")
    expect(env!.status).toBe("completed")
    expect(env!.output).toContain("Status: running")
    expect(env!.output).toContain("decoy")
    expect(env!.output).not.toContain("./emit-header.sh")

    const [row] = buildBackgroundTaskRows([
      poll({ output: SNAPSHOT, input: null }),
    ])
    expect(row.badge).toBe("completed")
    expect(row.command).toBe("./emit-header.sh")
    expect(row.output).toContain("decoy")
  })

  it("abstains whenever the header cannot be located with certainty", () => {
    // `Command:` interpolates the submitted command verbatim and unescaped
    // (`title: task.originalCommand`), so a multiline one pushes the header down
    // by an unknown amount — and since the command AND the captured output are
    // both arbitrary, either can reproduce the header run. No scan direction
    // resolves that, so the parser claims the row only when the run sits at its
    // fixed offset AND occurs nowhere else. Anything else renders generically,
    // as it did before this parser existed.
    const MULTILINE = `Shell ID: bash-9
Command: pnpm install &&
pnpm build
Status: completed
Duration: 12s
Timestamp: 2026-09-15T05:42:27.996Z

Stdout (full):
done

Stderr: (no output)`
    // (1) Ordinary multiline command: the run is not at its fixed offset.
    expect(parseBackgroundTaskEnvelope(MULTILINE)).toBeNull()

    // (2) A heredoc forging the run EXACTLY, immediately after `Command:` — the
    // case a fixed-offset check alone would accept, yielding the truncated
    // command `cat <<'EOF'` and the forged `running` status. Two candidate runs
    // exist, so nothing is claimed.
    expect(
      parseBackgroundTaskEnvelope(`Shell ID: bash-3
Command: cat <<'EOF'
Status: completed
Duration: fake
Timestamp: fake

Stdout (full):
EOF
Status: running
Duration: 1s
Timestamp: 2026-09-15T05:42:27.996Z

Stdout (full):
hi`)
    ).toBeNull()

    // (3) Single-line command whose OUTPUT reproduces the whole run — a forged
    // header and an innocent echo are indistinguishable here, so this abstains
    // too. Accepted cost of never emitting wrong data.
    expect(
      parseBackgroundTaskEnvelope(`Shell ID: bash-4
Command: ./emit-header.sh
Status: completed
Duration: 3s
Timestamp: 2026-09-15T05:42:27.996Z

Stdout (full):
Status: running
Duration: 99s
Timestamp: 2026-01-01T00:00:00.000Z

Stdout (full):
decoy`)
    ).toBeNull()

    // Abstaining means the row renders generically — never with a truncated
    // command or a status lifted out of unrelated text.
    const [row] = buildBackgroundTaskRows([
      poll({ output: MULTILINE, input: null }),
    ])
    expect(row.command).toBeNull()
    expect(row.output).toBeNull()
  })

  it("does not hijack ordinary tool output that merely mentions a task id", () => {
    expect(
      parseBackgroundTaskEnvelope("Task ID: agent-1 was dispatched earlier.")
    ).toBeNull()
    expect(
      parseBackgroundTaskEnvelope("Task ID: agent-1\nsomething else entirely")
    ).toBeNull()
    expect(parseBackgroundTaskEnvelope("Shell ID: s1\nStatus: done")).toBeNull()
    // Shell-shaped prefix whose header never closes: rejected outright rather
    // than half-parsed into a permanently-running row.
    expect(
      parseBackgroundTaskEnvelope("Shell ID: s1\nCommand: ls\nStatus: running")
    ).toBeNull()
    expect(
      parseBackgroundTaskEnvelope(
        "Shell ID: s1\nCommand: ls\nStatus: running\nDuration: 1s"
      )
    ).toBeNull()
    expect(
      isBackgroundTaskToolCall(
        poll({
          toolName: "Bash",
          input: null,
          output: "Shell ID: s1\nCommand: ls\nStatus: running",
        })
      )
    ).toBe(false)
  })

  it("renders a settled snapshot as a completed row carrying its report", () => {
    const [row] = buildBackgroundTaskRows([
      poll({ output: CB_AGENT_DONE, input: null }),
    ])
    // Regression: the report used to be dropped and the row stuck on "running".
    expect(row.badge).toBe("completed")
    expect(row.isSubagent).toBe(true)
    expect(row.output).toContain("Next.js 16.1.7 production build")
  })
})

describe("Grok sub-agent rows", () => {
  // Verbatim tail of a real 0.2.9x `TaskOutput.Result.output` for a polled
  // sub-agent (session 019fe6be…, `pnpm build`): the report ends with two
  // machine-facing blocks addressed to the parent model.
  const REPORT = [
    "## Build Result: **Succeeded**",
    "",
    "Optimized production build completed successfully.",
    "",
    "<subagent_meta>id=019fe6bf-0bcb-70c2-a02d-e5c006dfc32a, type=general-purpose, tool_calls=1, turns=1, duration_ms=18651</subagent_meta>",
    "",
    "<subagent_result>",
    "subagent_id: 019fe6bf-0bcb-70c2-a02d-e5c006dfc32a",
    "subagent_type: general-purpose",
    'To continue this subagent\'s conversation, use resume_from="019fe6bf-0bcb-70c2-a02d-e5c006dfc32a".',
    "</subagent_result>",
  ].join("\n")

  const SUBAGENT_TASK_OUTPUT = JSON.stringify({
    type: "TaskOutput",
    Result: {
      task_id: "019fe6bf-0bcb-70c2-a02d-e5c006dfc32a",
      command: "[subagent:general-purpose] Run pnpm build",
      status: "completed",
      exit_code: 0,
      output: REPORT,
    },
  })

  it("strips the meta / result scaffolding from the displayed output", () => {
    expect(stripGrokSubagentScaffolding(REPORT)).toBe(
      "## Build Result: **Succeeded**\n\nOptimized production build completed successfully."
    )
  })

  it("returns non-Grok output untouched (same reference)", () => {
    const plain = "$ next build\n✓ Compiled successfully\n"
    expect(stripGrokSubagentScaffolding(plain)).toBe(plain)
    expect(stripGrokSubagentScaffolding(null)).toBeNull()
  })

  it("flags a 0.2.9x `[subagent:…]` TaskOutput row and cleans its output", () => {
    const rows = buildBackgroundTaskRows([
      grokPoll({ output: SUBAGENT_TASK_OUTPUT }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].isSubagent).toBe(true)
    expect(rows[0].output).not.toContain("<subagent_meta>")
    expect(rows[0].output).not.toContain("resume_from")
    expect(rows[0].output).toContain("## Build Result")
  })

  it("leaves an ordinary background shell row alone", () => {
    const rows = buildBackgroundTaskRows([poll({ output: COMPLETED })])
    expect(rows[0].isSubagent).toBe(false)
  })
})

describe("isBackgroundTaskToolCall", () => {
  it("matches by raw tool name (historical path)", () => {
    expect(
      isBackgroundTaskToolCall(poll({ toolName: "TaskOutput", output: null }))
    ).toBe(true)
    expect(
      isBackgroundTaskToolCall(
        poll({
          toolName: "TaskStop",
          input: JSON.stringify({ task_id: "x" }),
          output: null,
        })
      )
    ).toBe(true)
  })

  it("matches by output envelope (live `task` alias)", () => {
    expect(
      isBackgroundTaskToolCall(poll({ toolName: "task", input: null }))
    ).toBe(true)
  })

  it("matches an in-flight poll by input shape (no output yet)", () => {
    expect(
      isBackgroundTaskToolCall(
        poll({ toolName: "task", output: null, state: "input-available" })
      )
    ).toBe(true)
  })

  it("does NOT match a real sub-agent Agent call", () => {
    expect(
      isBackgroundTaskToolCall(
        poll({
          toolName: "Agent",
          input: JSON.stringify({
            subagent_type: "Explore",
            task_id: "x",
            block: true,
          }),
          output: "the agent's final answer",
        })
      )
    ).toBe(false)
  })

  it("does NOT match get_delegation_status or cancel_delegation", () => {
    expect(
      isBackgroundTaskToolCall(
        poll({
          toolName: "mcp__codeg-mcp__get_delegation_status",
          input: JSON.stringify({ task_ids: ["a"] }),
          output: JSON.stringify({
            tasks: [{ task_id: "a", status: "running" }],
          }),
        })
      )
    ).toBe(false)
    expect(
      isBackgroundTaskToolCall(
        poll({
          toolName: "mcp__codeg-mcp__cancel_delegation",
          input: JSON.stringify({ task_id: "a" }),
          output: "Canceled task a",
        })
      )
    ).toBe(false)
  })

  it("does NOT match TaskUpdate", () => {
    expect(
      isBackgroundTaskToolCall(
        poll({
          toolName: "TaskUpdate",
          input: JSON.stringify({ taskId: "1", status: "completed" }),
          output: "ok",
        })
      )
    ).toBe(false)
  })
})

describe("buildBackgroundTaskRows", () => {
  it("collapses repeated polls of one task into a single completed row", () => {
    const rows = buildBackgroundTaskRows([
      poll({ toolCallId: "p1", output: RUNNING, state: "output-available" }),
      poll({ toolCallId: "p2", output: COMPLETED, state: "output-available" }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].badge).toBe("completed")
    expect(rows[0].exitCode).toBe(0)
    expect(rows[0].pollCount).toBe(2)
    expect(rows[0].output).toContain("test result: ok")
    expect(rows[0].taskId).toBe("bfb5xnq1t")
  })

  it("keeps parallel tasks as separate rows", () => {
    const rows = buildBackgroundTaskRows([
      poll({ toolCallId: "a", output: COMPLETED }),
      poll({
        toolCallId: "b",
        output: FAILED,
        input: JSON.stringify({ task_id: "bxx", block: true }),
      }),
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0].taskId).toBe("bfb5xnq1t")
    expect(rows[1].taskId).toBe("bxx")
    expect(rows[1].badge).toBe("failed")
    expect(rows[1].exitCode).toBe(1)
  })

  it("marks an in-flight poll as running", () => {
    const rows = buildBackgroundTaskRows([
      poll({ output: null, state: "input-available" }),
    ])
    expect(rows[0].badge).toBe("running")
    expect(rows[0].isInFlight).toBe(true)
  })

  it("drops an in-flight poll whose task_id has not streamed in yet", () => {
    // claude-agent-acp emits an arg-less initial tool_call (rawInput `{}`) and
    // fills the real args only on a later update, so a still-blocking live poll
    // has no envelope and no input id. It must NOT render as an anonymous row.
    const rows = buildBackgroundTaskRows([
      poll({ input: "{}", output: null, state: "input-available" }),
    ])
    expect(rows).toHaveLength(0)
  })

  it("does not stack repeated id-less in-flight re-polls into duplicate rows", () => {
    // The reported bug: N concurrent/re-issued anonymous polls each became a
    // separate "background task running" row. With one real task attributed and
    // three id-less in-flight checks, only the attributed row survives.
    const rows = buildBackgroundTaskRows([
      poll({
        toolCallId: "done",
        output: COMPLETED,
        state: "output-available",
      }),
      poll({
        toolCallId: "x1",
        input: "{}",
        output: null,
        state: "input-available",
      }),
      poll({
        toolCallId: "x2",
        input: null,
        output: null,
        state: "input-available",
      }),
      poll({
        toolCallId: "x3",
        input: "{}",
        output: null,
        state: "input-streaming",
      }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].taskId).toBe("bfb5xnq1t")
  })

  it("drops a promoted orphan (output-available but status still unsettled)", () => {
    // COMPLETE_TURN promotes the unpruned arg-less TaskOutput orphan: its state
    // flips to output-available, but its forwarded status stays pending. It must
    // not re-stack as an anonymous "background task running" row post-turn.
    const rows = buildBackgroundTaskRows([
      poll({
        toolCallId: "done",
        output: COMPLETED,
        state: "output-available",
      }),
      poll({
        toolCallId: "orphan",
        input: "{}",
        output: null,
        state: "output-available",
        toolStatus: "pending",
      }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].taskId).toBe("bfb5xnq1t")
  })

  it("still shows an id-less poll once it carries an envelope", () => {
    // A settled/output-available poll that parsed an envelope (even without a
    // resolvable id) is real content and keeps its row.
    const noIdEnvelope = `<retrieval_status>success</retrieval_status>
<status>completed</status>
<exit_code>0</exit_code>
<output>ok</output>`
    const rows = buildBackgroundTaskRows([
      poll({ input: null, output: noIdEnvelope, state: "output-available" }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].badge).toBe("completed")
  })

  it("derives a stopped badge + command from a TaskStop ack", () => {
    const rows = buildBackgroundTaskRows([
      poll({
        toolName: "TaskStop",
        input: JSON.stringify({ task_id: "bebna5yf2" }),
        output: STOP_JSON,
      }),
    ])
    expect(rows[0].badge).toBe("stopped")
    expect(rows[0].command).toBe("cd /x; echo hi")
  })
})
