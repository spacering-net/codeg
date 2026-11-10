import { describe, expect, it, vi } from "vitest"

import { ALL_AGENT_TYPES } from "@/lib/types"
import {
  coerceAssistantId,
  isAffirmedResume,
  isCodeModeDelegationCall,
  isCodeModeDelegationInput,
  isRefusedResume,
  parseDelegateTaskId,
  parseDelegationMeta,
  parseInput,
  parseToolOutput,
  resolveDelegationStatus,
} from "./delegation-card"

describe("parseInput wrapper peeling", () => {
  it("reads top-level delegation args", () => {
    const parsed = parseInput(
      JSON.stringify({
        agent_type: "codex",
        task: "run the build",
        working_dir: "/tmp/proj",
      })
    )
    expect(parsed.agentType).toBe("codex")
    expect(parsed.task).toBe("run the build")
    expect(parsed.workingDir).toBe("/tmp/proj")
  })

  it("peels Cursor's MCP args wrapper", () => {
    // Cursor surfaces MCP calls as {providerIdentifier, toolName, args} — the
    // delegation fields live one level down under `args`. Mirrors the Rust
    // walker in acp/lifecycle.rs (ARGS_WRAPPER_KEYS).
    const parsed = parseInput(
      JSON.stringify({
        providerIdentifier: "codeg-mcp",
        toolName: "delegate_to_agent",
        args: { agent_type: "claude_code", task: "执行 pnpm build" },
      })
    )
    expect(parsed.agentType).toBe("claude_code")
    expect(parsed.task).toBe("执行 pnpm build")
    expect(parsed.workingDir).toBeNull()
  })

  it("returns empty for undelegation-like payloads", () => {
    const parsed = parseInput(JSON.stringify({ command: "ls -la" }))
    expect(parsed.agentType).toBeNull()
    expect(parsed.task).toBeNull()
  })

  // Guards the allowlist against drifting behind the canonical agent list — the
  // regression that left `grok` and `cursor` delegation cards iconless. Every
  // known agent must resolve so its sub-agent card shows the right icon/label.
  it.each(ALL_AGENT_TYPES)("recognizes the %s agent_type", (agentType) => {
    const parsed = parseInput(
      JSON.stringify({ agent_type: agentType, task: "do the thing" })
    )
    expect(parsed.agentType).toBe(agentType)
  })
})

describe("codex live-wire result envelope", () => {
  /**
   * codex-acp forwards every MCP call's outcome as
   * `rawOutput = { result: <CallToolResult>, error: <string|null> }`
   * (`createMcpRawOutput`) — one layer above the shapes the parsers read.
   */
  function codexLive(callToolResult: Record<string, unknown>): string {
    return JSON.stringify({
      error: null,
      result: { meta: null, ...callToolResult },
    })
  }

  const runningAck = {
    agent_type: "codex",
    child_conversation_id: 2781,
    status: "running",
    task_id: "8cb72a7c-1a96-44aa-9c26-d4356862c9c2",
    message:
      "Delegation successful. task_id=8cb72a7c-1a96-44aa-9c26-d4356862c9c2.",
  }

  it("reads a running ack through the wrapper (ack, not a terminal outcome)", () => {
    const parsed = parseToolOutput(
      codexLive({
        content: [{ type: "text", text: runningAck.message }],
        structuredContent: runningAck,
      })
    )
    expect(parsed).toEqual({
      kind: "ack",
      childConversationId: 2781,
      agentType: "codex",
      // No refusal code — this is a real ack. See `isRefusedResume`.
      errorCode: null,
      // A plain agent delegation names no assistant.
      assistantId: null,
      assistantName: null,
    })
  })

  // Note: this one already passed pre-fix via the `task_id=<id>` text scan —
  // it guards that the structured path doesn't regress that resolution.
  it("resolves the task id through the wrapper", () => {
    const output = codexLive({
      content: [{ type: "text", text: "Delegation successful." }],
      structuredContent: runningAck,
    })
    expect(parseDelegateTaskId(output, null)).toBe(runningAck.task_id)
  })

  it("surfaces a failed envelope's error string instead of the raw JSON", () => {
    const parsed = parseToolOutput(
      JSON.stringify({ error: "mcp server disconnected", result: null })
    )
    expect(parsed).toEqual({
      kind: "outcome",
      text: "mcp server disconnected",
      isError: true,
      childConversationId: null,
    })
  })

  it("leaves a child's nested {status, task_id} payload alone", () => {
    // Peeling on the `result` KEY alone would turn opaque child output into a
    // failed delegation outcome and hand out `child-job` as the task id.
    const childOutput = JSON.stringify({
      result: { status: "failed", task_id: "child-job", message: "domain" },
    })
    expect(parseToolOutput(childOutput)).toEqual({
      kind: "outcome",
      text:
        "```json\n" +
        JSON.stringify(JSON.parse(childOutput), null, 2) +
        "\n```",
      isError: false,
      childConversationId: null,
    })
    expect(parseDelegateTaskId(childOutput, null)).toBeNull()
  })

  it("does NOT treat a child's own `error` field as a host failure", () => {
    // No `result` key ⇒ not codex-acp's failure envelope. Must stay a
    // non-error outcome rendered as-is.
    const childOutput = JSON.stringify({ error: "domain validation", rows: [] })
    const parsed = parseToolOutput(childOutput)
    expect(parsed).toMatchObject({ kind: "outcome", isError: false })
    expect(parsed).not.toMatchObject({ text: "domain validation" })
  })
})

describe("parseDelegationMeta task fields", () => {
  it("surfaces the broker-stamped task_preview and task_id", () => {
    // The persisted Cursor shape: raw_input is "{}" forever, so the meta the
    // broker stamped is the card's ONLY label source after a refresh.
    const parsed = parseDelegationMeta({
      "codeg.delegation": {
        status: "running",
        child_conversation_id: 42,
        task_preview: "执行 pnpm build",
        task_id: "task-uuid-1",
      },
    })
    expect(parsed).not.toBeNull()
    expect(parsed?.task).toBe("执行 pnpm build")
    expect(parsed?.taskId).toBe("task-uuid-1")
    expect(parsed?.childConversationId).toBe(42)
  })

  it("keeps task fields null when the meta lacks them (older backend)", () => {
    const parsed = parseDelegationMeta({
      "codeg.delegation": { status: "completed" },
    })
    expect(parsed?.task).toBeNull()
    expect(parsed?.taskId).toBeNull()
  })

  it("ignores empty and non-string task fields", () => {
    const parsed = parseDelegationMeta({
      "codeg.delegation": {
        status: "running",
        task_preview: "",
        task_id: 7,
      },
    })
    expect(parsed?.task).toBeNull()
    expect(parsed?.taskId).toBeNull()
  })

  it("surfaces the agent_type the historical injection supplies", () => {
    // Written only by `build_historical_delegation_meta` (from the child's DB
    // row). It is the agent-type source for a reloaded `resume_delegation`
    // card, whose arguments are just `{task_id, reason}`.
    const parsed = parseDelegationMeta({
      "codeg.delegation": { status: "completed", agent_type: "codex" },
    })
    expect(parsed?.agentType).toBe("codex")
  })

  it("rejects an unrecognized agent_type but keeps a custom one", () => {
    expect(
      parseDelegationMeta({
        "codeg.delegation": { status: "running", agent_type: "not_an_agent" },
      })?.agentType
    ).toBeNull()
    expect(
      parseDelegationMeta({
        "codeg.delegation": { status: "running", agent_type: "custom:my-cli" },
      })?.agentType
    ).toBe("custom:my-cli")
  })
})

describe("parseToolOutput agent type", () => {
  it("reads agent_type off the broker report", () => {
    // `delegate_to_agent` merely echoes its own argument here, but a
    // `resume_delegation` result is the ONLY place a reloaded card can learn
    // which agent came back.
    expect(
      parseToolOutput(
        JSON.stringify({
          task_id: "t-1",
          status: "running",
          agent_type: "codex",
          child_conversation_id: 9,
        })
      )
    ).toMatchObject({ kind: "ack", agentType: "codex", childConversationId: 9 })
  })

  it("carries agent_type onto a terminal outcome too", () => {
    expect(
      parseToolOutput(
        JSON.stringify({
          task_id: "t-1",
          status: "completed",
          agent_type: "claude_code",
          text: "all green",
        })
      )
    ).toMatchObject({
      kind: "outcome",
      agentType: "claude_code",
      isError: false,
    })
  })

  it("leaves agentType null when the report omits it", () => {
    expect(
      parseToolOutput(JSON.stringify({ task_id: "t-1", status: "running" }))
    ).toMatchObject({ kind: "ack", agentType: null })
  })
})

describe("assistant identity", () => {
  it("reads assistant_id off the call, a numeric string included", () => {
    expect(
      parseInput(
        JSON.stringify({ assistant_id: 3, task: "review", agent_type: "codex" })
      )
    ).toMatchObject({ assistantId: 3, agentType: "codex", task: "review" })
    expect(parseInput(JSON.stringify({ assistant_id: "12" })).assistantId).toBe(
      12
    )
  })

  it("finds the arguments by assistant_id alone, wrapped or not", () => {
    // A call naming only an assistant still is a delegation call.
    expect(
      parseInput(
        JSON.stringify({
          toolName: "delegate_to_agent",
          args: { assistant_id: 4 },
        })
      ).assistantId
    ).toBe(4)
  })

  it("ignores an id the backend would refuse", () => {
    for (const value of [0, -1, 1.5, "03", "abc", "", 2 ** 31, null, true]) {
      expect(coerceAssistantId(value)).toBeNull()
    }
    expect(coerceAssistantId(2 ** 31 - 1)).toBe(2 ** 31 - 1)
  })

  it("reads the assistant off the broker meta", () => {
    expect(
      parseDelegationMeta({
        "codeg.delegation": {
          status: "running",
          assistant_id: 3,
          assistant_name: "Reviewer",
        },
      })
    ).toMatchObject({ assistantId: 3, assistantName: "Reviewer" })
    expect(
      parseDelegationMeta({ "codeg.delegation": { status: "running" } })
    ).toMatchObject({ assistantId: null, assistantName: null })
  })

  it("reads the assistant off a report, ack and outcome alike", () => {
    const report = {
      task_id: "t-1",
      agent_type: "codex",
      assistant_id: 3,
      assistant_name: "Reviewer",
    }
    expect(
      parseToolOutput(JSON.stringify({ ...report, status: "running" }))
    ).toMatchObject({ kind: "ack", assistantId: 3, assistantName: "Reviewer" })
    expect(
      parseToolOutput(
        JSON.stringify({ ...report, status: "failed", error_code: "timeout" })
      )
    ).toMatchObject({
      kind: "outcome",
      isError: true,
      assistantId: 3,
      assistantName: "Reviewer",
    })
  })
})

describe("isRefusedResume", () => {
  // `not_resumable_report` (broker.rs) reports the task's REAL status, so a
  // refusal and a genuine resume differ only by `error_code`. Reading status
  // alone paints "Not resumed: it already completed" as a finished sub-agent.
  it.each(["completed", "running", "canceled"])(
    "recognizes a refusal reported with status %s",
    (status) => {
      expect(
        isRefusedResume(
          JSON.stringify({
            task_id: "t-1",
            status,
            error_code: "not_resumable",
            agent_type: "codex",
            child_conversation_id: 9,
            message: "Not resumed: the task already completed.",
          })
        )
      ).toBe(true)
    }
  )

  it("leaves a genuine resume ack alone", () => {
    expect(
      isRefusedResume(
        JSON.stringify({
          task_id: "t-1",
          status: "running",
          agent_type: "codex",
          child_conversation_id: 9,
          message: "Delegation resumed.",
        })
      )
    ).toBe(false)
  })

  // An unknown task id is refused too, but by a report that names no agent and
  // no child — nothing for a card to draw, so `hasModel` already handles it.
  it("does not claim an unknown-task report", () => {
    expect(
      isRefusedResume(
        JSON.stringify({
          task_id: "t-1",
          status: "unknown",
          message: "Unknown task id",
        })
      )
    ).toBe(false)
    expect(isRefusedResume(null)).toBe(false)
  })

  it("reads a refusal delivered as an error", () => {
    expect(
      isRefusedResume(
        null,
        JSON.stringify({
          task_id: "t-1",
          status: "failed",
          error_code: "not_resumable",
        })
      )
    ).toBe(true)
  })
})

// `render_task_report` keeps the whole report in `structuredContent` and
// renders only `message` as content text. OpenCode drops `structuredContent`
// wholesale ("the human-readable lines ARE the whole record",
// `acp/connection.rs`), so on those hosts the prefix is the only signal left.
describe("resume verdicts on hosts that drop structuredContent", () => {
  const REFUSAL_TEXT =
    "Not resumed: the task already completed — resume only applies to a canceled task."
  const ACK_TEXT =
    "Delegation resumed. task_id=t-1 (unchanged). Call get_delegation_status with this id."
  const UNKNOWN_TEXT =
    "Unknown task id — it never existed, isn't owned by this session, or its result was evicted."

  // Bare text is what actually arrives: `opencode_live_tool_output` returns
  // None whenever `content` carries the result (letting the clean text render)
  // and otherwise unwraps `rawOutput.output` to the bare string, and the
  // history parser mirrors it. So the `{output: …}` envelope never reaches
  // these predicates — which is why the text check can stay anchored.
  it("still recognizes a refusal from the message text alone", () => {
    expect(isRefusedResume(REFUSAL_TEXT)).toBe(true)
  })

  it("affirms a resume from the ack text alone", () => {
    expect(isAffirmedResume(ACK_TEXT)).toBe(true)
  })

  // A foreign task id lands on `unknown_report`. It must NOT affirm, or the
  // card would adopt another conversation's binding by task id alone.
  it("does not affirm an unknown-task report or a refusal", () => {
    expect(isAffirmedResume(UNKNOWN_TEXT)).toBe(false)
    expect(isAffirmedResume(REFUSAL_TEXT)).toBe(false)
    expect(isAffirmedResume(null)).toBe(false)
  })

  it("keeps the structured verdict authoritative when it survived", () => {
    const structured = JSON.stringify({
      task_id: "t-1",
      status: "running",
      agent_type: "codex",
      child_conversation_id: 9,
      message: ACK_TEXT,
    })
    expect(isRefusedResume(structured)).toBe(false)
    expect(isAffirmedResume(structured)).toBe(true)
  })
})

// `render_task_report` renders `text` in preference to `message` for a
// `completed` report, and a resume whose child finished during setup
// (`broker.rs`'s `Disposition::ChildTerminal`) reports the child's OWN
// LLM-written output there. A sub-agent that merely talks about delegation
// must not be read as a verdict about its own card — which is why the text
// check is anchored rather than a substring scan.
describe("resume verdicts never read a child's prose as a verdict", () => {
  const CHILD_PROSE =
    "I reviewed the resume path. The broker answers `Not resumed: <why>` when it " +
    "refuses, and `Delegation resumed. task_id=…` when it succeeds."

  it("ignores both markers when they appear inside a completed child's text", () => {
    const structured = JSON.stringify({
      task_id: "t-1",
      status: "completed",
      agent_type: "codex",
      child_conversation_id: 9,
      text: CHILD_PROSE,
    })
    expect(isRefusedResume(structured)).toBe(false)
    // Structure survived, so the child id — not the prose — is the confirmation.
    expect(isAffirmedResume(structured)).toBe(true)
  })

  it("ignores them in bare child text on a structure-dropping host", () => {
    expect(isRefusedResume(CHILD_PROSE)).toBe(false)
    expect(isAffirmedResume(CHILD_PROSE)).toBe(false)
  })

  // A structured report that named no child is `unknown_report` — the foreign
  // task id case. It must not affirm even though nothing refused it either.
  it("does not affirm a structured report that named no child", () => {
    const unknown = JSON.stringify({
      task_id: "t-1",
      status: "unknown",
      message: "Unknown task id — it never existed.",
    })
    expect(isAffirmedResume(unknown)).toBe(false)
  })

  // The legacy synchronous `{kind: "ok"|"err"}` shape is a RECOGNIZED report
  // too, so it must never fall through to the text path — otherwise a
  // legitimate result whose text merely opens with a marker gets read as a
  // verdict about the call.
  it("treats the legacy kind-shaped outcome as structured", () => {
    const legacyOk = JSON.stringify({
      kind: "ok",
      child_conversation_id: 9,
      text: "Not resumed: is the phrase the broker uses when it declines.",
    })
    expect(isRefusedResume(legacyOk)).toBe(false)
    expect(isAffirmedResume(legacyOk)).toBe(true)

    const legacyErr = JSON.stringify({
      kind: "err",
      code: "spawn_failed",
      message: "Delegation resumed is the phrase used on success.",
    })
    expect(isRefusedResume(legacyErr)).toBe(false)
    // No child named ⇒ nothing corroborates a task-id binding.
    expect(isAffirmedResume(legacyErr)).toBe(false)
  })
})

// opencode 2.x code-mode: MCP calls execute as JS source inside the built-in
// `execute` tool, arriving as raw_input `{"code": "…tools[\"codeg-mcp\"].
// delegate_to_agent({…})…"}`. The scanner/unescaper here mirrors
// `acp/lifecycle.rs` (`code_mode_call_span` & friends) — these cases pin the
// shared predicate so the two sides can never disagree about what counts as
// a delegation call.
describe("opencode code-mode execute payloads", () => {
  // The exact literal the Rust 对拍 test uses (`lifecycle.rs::
  // code_mode_key_matches_the_mcp_side_for_the_same_call`): a real opencode
  // emission — bracketed accessor, working_dir, template task with escaped
  // newline/tab, CJK text. The `\\n`/`\\t` are JS SOURCE escapes; the runtime
  // cooks them to a real newline/tab, which is what the card must show.
  const OPENCODE_CALL =
    'await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", working_dir: "/tmp/对拍", task: `review 对拍\\nsecond\\tline ✓` })'

  it("recognizes and parses the opencode emission", () => {
    const raw = JSON.stringify({ code: OPENCODE_CALL })
    expect(isCodeModeDelegationInput(raw)).toBe(true)
    const parsed = parseInput(raw)
    expect(parsed.agentType).toBe("codex")
    expect(parsed.task).toBe("review 对拍\nsecond\tline ✓")
    expect(parsed.workingDir).toBe("/tmp/对拍")
    expect(parsed.assistantId).toBeNull()
  })

  it("parses an LS/PS-bearing emission verbatim like the MCP side", () => {
    // U+2028/U+2029 pass through BOTH sides verbatim (ECMA-262 TV-normalizes
    // only CR/CRLF), so the card shows exactly what the listener receives.
    const raw = JSON.stringify({
      code: 'tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: `seg\u2028a\u2029b` })',
    })
    expect(isCodeModeDelegationInput(raw)).toBe(true)
    const parsed = parseInput(raw)
    expect(parsed.agentType).toBe("codex")
    expect(parsed.task).toBe("seg\u2028a\u2029b")
  })

  it("parses the namespaced accessor form with working_dir", () => {
    const raw = JSON.stringify({
      code: `await tools.codeg_mcp.delegate_to_agent({ agent_type: 'codex', task: 'ship it', working_dir: "/tmp/proj" })`,
    })
    expect(isCodeModeDelegationInput(raw)).toBe(true)
    const parsed = parseInput(raw)
    expect(parsed.agentType).toBe("codex")
    expect(parsed.task).toBe("ship it")
    expect(parsed.workingDir).toBe("/tmp/proj")
  })

  it("unescapes the minimal JS escape set in template tasks", () => {
    const raw = JSON.stringify({
      code: `tools["codeg-mcp"].delegate_to_agent({ agent_type: "zcode", task: \`a\\nb\\tc\\u4e2d\\u{1F600}\` })`,
    })
    const parsed = parseInput(raw)
    expect(parsed.task).toBe("a\nb\tc中😀")
  })

  it("rejects shapes that are not delegation calls", () => {
    const negatives: unknown[] = [
      "not json at all",
      JSON.stringify({ code: 42 }),
      JSON.stringify({}),
      JSON.stringify({ command: "ls" }),
      // A different method on the same accessor is an execute call, not ours.
      JSON.stringify({ code: `tools["codeg-mcp"].list_agents({})` }),
      // `tools.search` is a plain method call, not an accessor chain.
      JSON.stringify({ code: `tools.search({ query: "delegate_to_agent" })` }),
      // The call shape inside a string/template/comment is not a call site.
      JSON.stringify({
        code: `const s = "tools[\\"codeg-mcp\\"].delegate_to_agent("`,
      }),
      JSON.stringify({
        code: 'const t = `tools["codeg-mcp"].delegate_to_agent()`',
      }),
      JSON.stringify({
        code: `// tools["codeg-mcp"].delegate_to_agent({ agent_type: "zcode" })`,
      }),
    ]
    for (const raw of negatives) {
      expect(isCodeModeDelegationInput(raw as string)).toBe(false)
      const parsed = parseInput(raw as string)
      expect(parsed.agentType).toBeNull()
      expect(parsed.task).toBeNull()
    }
  })

  it("keeps the card renderable when a value is unreadable", () => {
    // `${…}` interpolation evaluates differently than the source reads —
    // the backend goes unkeyed, the card degrades to the generic task row.
    const interp = JSON.stringify({
      code: 'tools["codeg-mcp"].delegate_to_agent({ agent_type: "zcode", task: `hi ${name}` })',
    })
    expect(isCodeModeDelegationInput(interp)).toBe(true)
    expect(parseInput(interp)).toEqual({
      agentType: "zcode",
      assistantId: null,
      task: null,
      workingDir: null,
    })

    // An escape outside the minimal set bails the same way.
    const unknownEscape = JSON.stringify({
      code: 'tools["codeg-mcp"].delegate_to_agent({ agent_type: "zcode", task: `a\\qb` })',
    })
    expect(isCodeModeDelegationInput(unknownEscape)).toBe(true)
    expect(parseInput(unknownEscape).task).toBeNull()

    // An escaped quoted task could decode differently than it reads — bail.
    const escapedQuoted = JSON.stringify({
      code: 'tools["codeg-mcp"].delegate_to_agent({ agent_type: "zcode", task: "a\\nb" })',
    })
    expect(isCodeModeDelegationInput(escapedQuoted)).toBe(true)
    expect(parseInput(escapedQuoted).task).toBeNull()

    // No agent_type / an unknown slug: still a call, generic card.
    const noAgent = JSON.stringify({
      code: 'tools["codeg-mcp"].delegate_to_agent({ task: `t` })',
    })
    expect(isCodeModeDelegationInput(noAgent)).toBe(true)
    expect(parseInput(noAgent).agentType).toBeNull()

    const badAgent = JSON.stringify({
      code: 'tools["codeg-mcp"].delegate_to_agent({ agent_type: "nope", task: `t` })',
    })
    expect(parseInput(badAgent).agentType).toBeNull()
  })

  it("reads a stringified assistant_id without mistaking the target", () => {
    // Mixed shape `{assistant_id: "3", agent_type: …}` resolves to the
    // ASSISTANT on the backend (key deliberately not minted — see
    // `lifecycle.rs::extract_code_mode_match_key`); the card only needs
    // display values, so both identities surface.
    const raw = JSON.stringify({
      code: 'tools["codeg-mcp"].delegate_to_agent({ assistant_id: "3", agent_type: "codex", task: `t` })',
    })
    expect(isCodeModeDelegationInput(raw)).toBe(true)
    const parsed = parseInput(raw)
    expect(parsed.assistantId).toBe(3)
    expect(parsed.agentType).toBe("codex")
    expect(parsed.task).toBe("t")
  })

  it("reads a bare numeric assistant_id in every spelling", () => {
    // `assistant_id: 3` is the common spelling; leaving it unread would make
    // the card fall back to `agent_type` and mislabel an Assistant run.
    const bare = JSON.stringify({
      code: 'tools["codeg-mcp"].delegate_to_agent({ assistant_id: 3, agent_type: "codex", task: `t` })',
    })
    const bareParsed = parseInput(bare)
    expect(bareParsed.assistantId).toBe(3)
    expect(bareParsed.agentType).toBe("codex")

    const quotedKey = JSON.stringify({
      code: 'tools["codeg-mcp"].delegate_to_agent({ "assistant_id": 3, task: `t` })',
    })
    expect(parseInput(quotedKey).assistantId).toBe(3)

    const quotedBoth = JSON.stringify({
      code: 'tools["codeg-mcp"].delegate_to_agent({ "assistant_id": "3", task: `t` })',
    })
    expect(parseInput(quotedBoth).assistantId).toBe(3)

    // A bare number NOT ending its property is not the value.
    const concat = JSON.stringify({
      code: 'tools["codeg-mcp"].delegate_to_agent({ assistant_id: 3 + 1, task: `t` })',
    })
    expect(parseInput(concat).assistantId).toBeNull()
  })

  it("degrades the parse when working_dir is present but unreadable", () => {
    // Present-and-unreadable is not the same as absent: the backend bails
    // the whole key (the MCP side sees Some(dir)); the card just shows the
    // fields it can read.
    const cases = [
      'tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", working_dir: "C:\\\\proj", task: `t` })',
      'tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", working_dir: `${cwd}/proj`, task: `t` })',
      'tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", working_dir: projectDir, task: `t` })',
      'tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", working_dir: "/tmp" + "/w", task: `t` })',
    ]
    for (const code of cases) {
      const raw = JSON.stringify({ code })
      expect(isCodeModeDelegationInput(raw)).toBe(true)
      const parsed = parseInput(raw)
      expect(parsed.workingDir).toBeNull()
      expect(parsed.agentType).toBe("codex")
      expect(parsed.task).toBe("t")
    }
  })

  it("does not read a value that continues past its literal", () => {
    // A literal followed by an operator evaluates to something else at
    // runtime; reading the literal alone would mislabel the card.
    const taskConcat = JSON.stringify({
      code: 'tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "a" + b })',
    })
    expect(parseInput(taskConcat).task).toBeNull()
    expect(parseInput(taskConcat).agentType).toBe("codex")

    const taskMethod = JSON.stringify({
      code: 'tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: `a`.trim() })',
    })
    expect(parseInput(taskMethod).task).toBeNull()

    const agentConcat = JSON.stringify({
      code: 'tools["codeg-mcp"].delegate_to_agent({ agent_type: "co" + "dex", task: `t` })',
    })
    expect(parseInput(agentConcat).agentType).toBeNull()
    expect(parseInput(agentConcat).task).toBe("t")

    const dirConcat = JSON.stringify({
      code: 'tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", working_dir: "/a" + suffix, task: `t` })',
    })
    expect(parseInput(dirConcat).workingDir).toBeNull()
    expect(parseInput(dirConcat).task).toBe("t")

    // Duplicate keys take the LAST spelling — the one the runtime uses.
    const dup = JSON.stringify({
      code: 'tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: `stale`, task: `fresh` })',
    })
    expect(parseInput(dup).task).toBe("fresh")

    // …and a later unreadable spelling degrades the read instead of keying
    // the earlier readable one.
    const dupUnreadable = JSON.stringify({
      code: 'tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: `stale`, task: "a" + b })',
    })
    expect(parseInput(dupUnreadable).task).toBeNull()
  })

  it("accepts comments between values and their property terminators", () => {
    const raw = JSON.stringify({
      code: `tools["codeg-mcp"].delegate_to_agent({
  // choose the agent
  agent_type: "codex", /* trailing */ task: \`t\` /* last */, // done
})`,
    })
    expect(isCodeModeDelegationInput(raw)).toBe(true)
    const parsed = parseInput(raw)
    expect(parsed.agentType).toBe("codex")
    expect(parsed.task).toBe("t")
  })

  it("reads quoted property keys and ignores nested same-named keys", () => {
    const quoted = JSON.stringify({
      code: 'tools["codeg-mcp"].delegate_to_agent({ "agent_type": "codex", \'task\': "plain" })',
    })
    expect(isCodeModeDelegationInput(quoted)).toBe(true)
    expect(parseInput(quoted).agentType).toBe("codex")
    expect(parseInput(quoted).task).toBe("plain")

    // The backend reads FLAT args, so a same-named key inside a sub-object
    // must not surface — in either source order.
    const nested = JSON.stringify({
      code: `tools["codeg-mcp"].delegate_to_agent({
  meta: { agent_type: "zzz", task: \`decoy\` },
  agent_type: "codex",
  task: \`real\`,
})`,
    })
    const parsed = parseInput(nested)
    expect(parsed.agentType).toBe("codex")
    expect(parsed.task).toBe("real")

    const nestedRev = JSON.stringify({
      code: 'tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: `real`, meta: { task: `decoy`, agent_type: "zzz" } })',
    })
    const parsedRev = parseInput(nestedRev)
    expect(parsedRev.agentType).toBe("codex")
    expect(parsedRev.task).toBe("real")
  })

  it("screens unknowable argument syntax out of the parse entirely", () => {
    // Spread may carry an assistant_id; a `[` covers computed keys and array
    // values. The call still renders as a delegation card (the backend
    // registers it unkeyed), but the card content is the generic task row.
    const cases = [
      'tools["codeg-mcp"].delegate_to_agent({ ...base, task: `t` })',
      'tools["codeg-mcp"].delegate_to_agent({ ["assistant_id"]: 3, agent_type: "codex", task: `t` })',
      'tools["codeg-mcp"].delegate_to_agent({ ["agent_type"]: "codex", task: `t` })',
    ]
    for (const code of cases) {
      const raw = JSON.stringify({ code })
      expect(isCodeModeDelegationInput(raw)).toBe(true)
      expect(parseInput(raw)).toEqual({
        agentType: null,
        assistantId: null,
        task: null,
        workingDir: null,
      })
    }
  })

  it("normalizes template line terminators the way the JS runtime cooks them", () => {
    // TV normalization: bare CR and CRLF collapse to a single LF; a backslash
    // line continuation contributes nothing. (A literal CRLF inside the JS
    // source survives JSON.stringify round-trip.)
    const crlf = JSON.stringify({
      code: 'tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: `a\r\nb\rc` })',
    })
    expect(parseInput(crlf).task).toBe("a\nb\nc")

    const ls = JSON.stringify({
      code: 'tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: `a b` })',
    })
    // U+2028/U+2029 are JS line terminators but NOT TV-normalized (ECMA-262
    // rewrites only CR and CRLF); they pass through verbatim.
    expect(parseInput(ls).task).toBe("a\u2028b")

    const ps = JSON.stringify({
      code: 'tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: `a\u2029b` })',
    })
    expect(parseInput(ps).task).toBe("a\u2029b")

    const cont = JSON.stringify({
      code: 'tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: `a\\\r\nb` })',
    })
    expect(parseInput(cont).task).toBe("ab")
  })

  it("bails to the generic row when args syntax is unreadable", () => {
    // Shorthand properties evaluate to the variable's runtime value; nested
    // calls and regex literals are expressions the scanner cannot evaluate —
    // and a regex body could feed quotes/braces to the string/template arms.
    const cases = [
      'tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: `t`, working_dir })',
      'tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: `t`, assistant_id })',
      'tools["codeg-mcp"].delegate_to_agent({ agent_type: pick("codex"), task: `t` })',
      'tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: `t`, flag: /}/ })',
    ]
    for (const code of cases) {
      const raw = JSON.stringify({ code })
      expect(isCodeModeDelegationInput(raw)).toBe(true)
      expect(parseInput(raw)).toEqual({
        agentType: null,
        assistantId: null,
        task: null,
        workingDir: null,
      })
    }
  })

  it("reads nothing unless the argument is exactly one object literal", () => {
    const empty = {
      agentType: null,
      assistantId: null,
      task: null,
      workingDir: null,
    }
    // What runs is whatever these expressions evaluate to, which the first
    // literal in them does not determine. A second argument object makes
    // OpenCode throw "expects at most one input object" before any MCP call.
    const cases = [
      'tools["codeg-mcp"].delegate_to_agent(c ? { agent_type: "codex", task: `a` } : { agent_type: "codex", task: `b` })',
      'tools["codeg-mcp"].delegate_to_agent(x || { agent_type: "codex", task: `decoy` })',
      'tools["codeg-mcp"].delegate_to_agent(x ?? { agent_type: "codex", task: `decoy` })',
      'tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: `t` }.y)',
      'tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: `t` }, { agent_type: "goose", task: `u` })',
      'tools["codeg-mcp"].delegate_to_agent(args)',
    ]
    for (const code of cases) {
      const raw = JSON.stringify({ code })
      expect(isCodeModeDelegationInput(raw)).toBe(true)
      expect(parseInput(raw)).toEqual(empty)
    }
    // A trailing comma still leaves exactly one argument.
    const trailing = JSON.stringify({
      code: 'tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: `t` }, /* end */ )',
    })
    expect(parseInput(trailing).task).toBe("t")
  })

  it("reads nothing when later syntax can override or hide a key", () => {
    // Each of these passes a different `task`/`agent_type` at runtime than an
    // earlier explicit spelling: a later shorthand, a Unicode-escaped key, a
    // ternary (whose string reads like a key before its `:`), and a
    // duplicate key behind non-ASCII whitespace the word matcher cannot see.
    const cases = [
      'tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "decoy", task })',
      'tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "t", agent_type })',
      'tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "decoy", \\u0074ask: "real" })',
      'tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: c ? "task" : "real" })',
      'tools["codeg-mcp"].delegate_to_agent({ agent_type: c ? "agent_type" : "codex", task: "t" })',
      'tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: obj?.task })',
      'tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "decoy",\u00a0task: "real" })',
      'tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "decoy",\ufefftask: "real" })',
    ]
    for (const code of cases) {
      const raw = JSON.stringify({ code })
      expect(isCodeModeDelegationInput(raw)).toBe(true)
      const parsed = parseInput(raw)
      expect(parsed.task).toBeNull()
      expect(parsed.agentType).toBeNull()
    }
  })

  it("classifies only opencode's execute tool by its code", () => {
    // Another tool's `code` argument — a Playwright script that mocks the
    // call, say — is no delegation; the backend doesn't register it either.
    const raw = JSON.stringify({
      code: "async page => { const tools = {'codeg-mcp': {delegate_to_agent: async x => x}}; await tools['codeg-mcp'].delegate_to_agent({agent_type:'codex',task:'review'}); }",
    })
    expect(isCodeModeDelegationInput(raw)).toBe(true)
    // `execute` normalizes to `bash`, live and in history.
    expect(isCodeModeDelegationCall("bash", raw)).toBe(true)
    expect(
      isCodeModeDelegationCall("mcp__playwright__browser_run_code", raw)
    ).toBe(false)
  })

  it("declines a script with a slash before the call", () => {
    // `/'/` opens a "string" that skips the real call and closes in a later
    // comment, whose example then reads as the call site.
    const desync = JSON.stringify({
      code: `const re = /'/;\nawait tools["codeg-mcp"].delegate_to_agent({agent_type:"codex",task:"real"});\n// here's an example: tools["codeg-mcp"].delegate_to_agent({agent_type:"codex",task:"decoy"})`,
    })
    expect(isCodeModeDelegationInput(desync)).toBe(false)

    // After a call that runs first, a slash changes nothing…
    const after = JSON.stringify({
      code: 'const r = await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "t" }); return r.ms / 1000',
    })
    expect(parseInput(after).task).toBe("t")

    // …after one that may not run, it hides whether another site exists.
    const unsure = JSON.stringify({
      code: 'if (bad) { await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "t" }) } const n = 4 / 2',
    })
    expect(isCodeModeDelegationInput(unsure)).toBe(true)
    expect(parseInput(unsure).task).toBeNull()
  })

  it("reads the first of several calls only when it runs first", () => {
    const task = (code: string) => {
      const raw = JSON.stringify({ code })
      expect(isCodeModeDelegationInput(raw)).toBe(true)
      return parseInput(raw).task
    }
    expect(
      task(
        'await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "A" }); await tools["codeg-mcp"].delegate_to_agent({ agent_type: "zcode", task: "B" })'
      )
    ).toBe("A")
    expect(
      task(
        'const [a, b] = await Promise.allSettled([tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "A" }), tools["codeg-mcp"].delegate_to_agent({ agent_type: "zcode", task: "B" })])'
      )
    ).toBe("A")
    // A lone call reads wherever it sits: if it runs, it is the call.
    expect(
      task(
        'if (failed) { await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "fix" }) }'
      )
    ).toBe("fix")
    expect(
      task(
        'const r = await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "A" }); await tools["codeg-mcp"].delegate_to_agent({ agent_type: "zcode", task: "B" }); return `${r.task_id}`'
      )
    ).toBe("A")
    expect(
      task(
        'await Promise.allSettled([tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "A" }), tools["codeg-mcp"].delegate_to_agent({ agent_type: "zcode", task: "B" })]).then(rs => rs)'
      )
    ).toBe("A")
    expect(
      task(
        'return await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "A" })'
      )
    ).toBe("A")
    // The first site may not run while a later one does: a branch, a deferred
    // function or parameter default, a destructuring default, or a `${…}` the
    // count cannot see; one case per construct.
    for (const code of [
      'const later = (x = tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "decoy" })) => x; await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "real" })',
      'const later = async (x = tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "decoy" })) => x; await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "real" })',
      'function later(x = tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "decoy" })) { return x } await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "real" })',
      'const [a = tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "decoy" })] = [1]; await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "real" })',
      'if (false) { await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "decoy" }) } const text = `${await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "real" })}`',
      'const text = `${await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "real" })}`; if (c) { await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "decoy" }) }',
      'c && await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "A" }); await tools["codeg-mcp"].delegate_to_agent({ agent_type: "zcode", task: "B" })',
      'c || await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "A" }); await tools["codeg-mcp"].delegate_to_agent({ agent_type: "zcode", task: "B" })',
      'switch (c) {} await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "A" }); await tools["codeg-mcp"].delegate_to_agent({ agent_type: "zcode", task: "B" })',
      'for (const x of xs) {} await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "A" }); await tools["codeg-mcp"].delegate_to_agent({ agent_type: "zcode", task: "B" })',
      'while (false) {} await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "A" }); await tools["codeg-mcp"].delegate_to_agent({ agent_type: "zcode", task: "B" })',
      'do {} while (false); await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "A" }); await tools["codeg-mcp"].delegate_to_agent({ agent_type: "zcode", task: "B" })',
      'try {} catch (e) {} await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "A" }); await tools["codeg-mcp"].delegate_to_agent({ agent_type: "zcode", task: "B" })',
      'const t = `${await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "real" })}`; return t; await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "A" }); await tools["codeg-mcp"].delegate_to_agent({ agent_type: "zcode", task: "B" })',
      'const f = (x = tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "decoy" }), y = 1 / 2) => x; await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "real" })',
      'if (false) { await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "decoy" }) } await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "real" })',
      'c ? tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "A" }) : tools["codeg-mcp"].delegate_to_agent({ agent_type: "zcode", task: "B" })',
      'if (c) await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "A" }); else await tools["codeg-mcp"].delegate_to_agent({ agent_type: "zcode", task: "B" })',
      'const later = () => tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "A" }); await tools["codeg-mcp"].delegate_to_agent({ agent_type: "zcode", task: "B" })',
      'async function go() { await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "A" }) } await tools["codeg-mcp"].delegate_to_agent({ agent_type: "zcode", task: "B" })',
    ]) {
      expect(task(code)).toBeNull()
    }
  })

  it("caps the script in UTF-8 bytes, as the backend does", () => {
    const call =
      'tools.codeg_mcp.delegate_to_agent({agent_type:"codex",task:"t"})'
    // 350,000 CJK characters are 1,050,000 bytes: past the 1 MiB cap the
    // backend measures, though under it in UTF-16 units.
    const wide = JSON.stringify({
      code: "/*" + "中".repeat(350000) + "*/" + call,
    })
    expect(isCodeModeDelegationInput(wide)).toBe(false)
    const ascii = JSON.stringify({
      code: "/*" + "a".repeat((1 << 20) - 200) + "*/" + call,
    })
    expect(isCodeModeDelegationInput(ascii)).toBe(true)
  })

  it("reads an unreadable call quietly: its shape is a known one", () => {
    // The unknown-shape breadcrumb is for wrappers nobody has accounted for;
    // a recognized call whose arguments can't be read is not one, and the
    // card re-parses its input on every render.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const raw = JSON.stringify({
        code: 'tools["codeg-mcp"].delegate_to_agent({ ...base, task: `t` })',
      })
      expect(parseInput(raw).task).toBeNull()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it("ends line comments at every JS line terminator", () => {
    // ECMA-262 line comments end at CR, LF, U+2028 and U+2029; a scanner
    // stopping only at LF would swallow the real code after the others.
    const cr = JSON.stringify({
      code: 'tools["codeg-mcp"].delegate_to_agent({ // pick\r agent_type: "codex", task: `t` })',
    })
    expect(parseInput(cr).task).toBe("t")

    const ls = JSON.stringify({
      code: '// delegate\u2028await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: `t` })',
    })
    expect(isCodeModeDelegationInput(ls)).toBe(true)
    expect(parseInput(ls).task).toBe("t")

    // Inside the argument object the terminator is non-ASCII code the word
    // matcher cannot delimit, so the read degrades rather than guesses.
    const lsInArgs = JSON.stringify({
      code: 'tools["codeg-mcp"].delegate_to_agent({ // pick\u2028 agent_type: "codex", task: `t` })',
    })
    expect(isCodeModeDelegationInput(lsInArgs)).toBe(true)
    expect(parseInput(lsInArgs).task).toBeNull()
  })
})

describe("resolveDelegationStatus and a later check", () => {
  const ack = parseToolOutput(
    JSON.stringify({ task_id: "t1", status: "started" })
  )
  const base = {
    binding: undefined,
    parsedMeta: null,
    toolOutput: ack,
    state: "output-available" as const,
    errorText: null,
    childAwaitingUser: false,
  }

  it("lets a check that came after the ack say how the task ended", () => {
    expect(resolveDelegationStatus(base)).toBe("running")
    expect(resolveDelegationStatus({ ...base, ended: { status: "ok" } })).toBe(
      "ok"
    )
    expect(resolveDelegationStatus({ ...base, ended: { status: "err" } })).toBe(
      "err"
    )
  })

  it("keeps the live binding and the stored meta ahead of any check", () => {
    const meta = parseDelegationMeta({
      "codeg.delegation": { status: "running", child_conversation_id: 7 },
    })
    expect(
      resolveDelegationStatus({
        ...base,
        parsedMeta: meta,
        ended: { status: "ok" },
      })
    ).toBe("running")
    expect(
      resolveDelegationStatus({
        ...base,
        childAwaitingUser: true,
        ended: { status: "ok" },
      })
    ).toBe("waiting")
  })
})
