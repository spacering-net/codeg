import { describe, expect, it } from "vitest"

import {
  parsePermissionOptionChanges,
  parsePermissionToolCall,
} from "./permission-request"

function metaWith(changes: unknown[]): Record<string, unknown> {
  return { permission: { version: 1, changes } }
}

describe("parsePermissionOptionChanges", () => {
  it("keeps the agent's description and normalizes every lifetime shape", () => {
    // The six shapes the two adapters emit. claude-agent-acp ≥0.64.1 (#930)
    // spans all of them; codex-acp only ever sends `{scope: "session"}`.
    const changes = parsePermissionOptionChanges(
      metaWith([
        { description: "session", lifetime: { scope: "session" } },
        {
          description: "process",
          lifetime: { scope: "process", storage: "cli_argument" },
        },
        {
          description: "user",
          lifetime: { scope: "persistent", storage: "user" },
        },
        {
          description: "project",
          lifetime: { scope: "persistent", storage: "project" },
        },
        {
          description: "local",
          lifetime: { scope: "persistent", storage: "project_local" },
        },
        // Persistent with a storage this build has never seen: the destination
        // is unknown but "outlives the session" must still reach the user.
        {
          description: "future",
          lifetime: { scope: "persistent", storage: "enterprise_policy" },
        },
      ])
    )
    expect(changes).toEqual([
      { description: "session", scope: "session" },
      { description: "process", scope: "process" },
      { description: "user", scope: "user" },
      { description: "project", scope: "project" },
      { description: "local", scope: "project_local" },
      { description: "future", scope: "persistent" },
    ])
  })

  it("reports no scope when the lifetime is absent, unknown, or malformed", () => {
    const changes = parsePermissionOptionChanges(
      metaWith([
        { description: "no lifetime at all" },
        { description: "explicitly unknown", lifetime: { scope: "unknown" } },
        { description: "scope from the future", lifetime: { scope: "orbit" } },
        { description: "lifetime is not an object", lifetime: 42 },
        { description: "empty lifetime", lifetime: {} },
      ])
    )
    expect(changes.map((c) => c.scope)).toEqual([null, null, null, null, null])
    // The sentence itself still renders — only the duration is withheld.
    expect(changes.map((c) => c.description)).toHaveLength(5)
  })

  it("drops changes without a description but keeps the rest", () => {
    const changes = parsePermissionOptionChanges(
      metaWith([
        { lifetime: { scope: "session" } },
        { description: "   ", lifetime: { scope: "session" } },
        { description: "kept", lifetime: { scope: "session" } },
      ])
    )
    expect(changes).toEqual([{ description: "kept", scope: "session" }])
  })

  it("caps the list and the per-description length", () => {
    const changes = parsePermissionOptionChanges(
      metaWith(
        Array.from({ length: 9 }, (_, i) => ({
          description: `x`.repeat(250) + i,
          lifetime: { scope: "session" },
        }))
      )
    )
    expect(changes).toHaveLength(6)
    expect(changes[0].description).toHaveLength(200)
  })

  it("returns nothing for metadata it does not understand", () => {
    // A future revision may reshape `changes`; showing it half-understood is
    // worse than showing nothing.
    expect(
      parsePermissionOptionChanges({
        permission: { version: 2, changes: [{ description: "nope" }] },
      })
    ).toEqual([])
    expect(
      parsePermissionOptionChanges({ permission: { version: 1, changes: {} } })
    ).toEqual([])
    expect(parsePermissionOptionChanges({ somethingElse: true })).toEqual([])
    expect(parsePermissionOptionChanges(null)).toEqual([])
    expect(parsePermissionOptionChanges(undefined)).toEqual([])
  })

  it("reads codex-acp ≥1.7.0's flat description as one scope-less change", () => {
    // 1.7.0 dropped `changes[]`; MCP elicitation approvals now carry the
    // explanation directly. No lifetime is sent, so no duration is claimed.
    expect(
      parsePermissionOptionChanges({
        permission: {
          version: 1,
          description:
            "Run the tool and remember this choice for this session.",
        },
      })
    ).toEqual([
      {
        description: "Run the tool and remember this choice for this session.",
        scope: null,
      },
    ])
    // `changes[]` still wins where an adapter sends it (claude ≥0.64.1).
    expect(
      parsePermissionOptionChanges({
        permission: {
          version: 1,
          description: "ignored",
          changes: [{ description: "kept", lifetime: { scope: "session" } }],
        },
      })
    ).toEqual([{ description: "kept", scope: "session" }])
    // Same version gate as the structured form.
    expect(
      parsePermissionOptionChanges({
        permission: { version: 2, description: "nope" },
      })
    ).toEqual([])
  })
})

describe("parsePermissionToolCall — request-level _meta.permission", () => {
  it("surfaces the codex reason and prefers its title over the generic one", () => {
    // codex-acp ≥1.7.0, after the backend hoists the request meta onto the
    // card. Before 1.7.0 this sentence WAS `toolCall.title`, so dropping it
    // would be a straight regression on upgrade.
    const parsed = parsePermissionToolCall({
      toolCallId: "command-7",
      kind: "execute",
      status: "pending",
      title: "Run command",
      rawInput: { command: "npm test", cwd: "/workspace" },
      _meta: {
        permission: {
          version: 1,
          title: "Run command?",
          description:
            "The test suite needs to run outside the current sandbox.",
        },
      },
    })
    expect(parsed.reason).toBe(
      "The test suite needs to run outside the current sandbox."
    )
    expect(parsed.description).toBe("Run command?")
    // The standard fields stay authoritative for the action itself.
    expect(parsed.command).toBe("npm test")
    expect(parsed.title).toBe("Run command")
  })

  it("keeps claude's action title ahead of the permission title", () => {
    // `_meta.claudeCode.title` names the ACTION and has always been the
    // heading; the permission block only fills a gap claude does not leave.
    const parsed = parsePermissionToolCall({
      toolCallId: "t1",
      title: "npm test",
      _meta: {
        claudeCode: { title: "Run the test suite" },
        permission: { version: 1, title: "Run command?", description: "why" },
      },
    })
    expect(parsed.description).toBe("Run the test suite")
    expect(parsed.reason).toBe("why")
  })

  it("reports no reason for agents that send none, or a version it cannot read", () => {
    expect(parsePermissionToolCall({ toolCallId: "t1" }).reason).toBeNull()
    expect(
      parsePermissionToolCall({
        toolCallId: "t1",
        _meta: { permission: { version: 1, title: "Make edits?" } },
      }).reason
    ).toBeNull()
    expect(
      parsePermissionToolCall({
        toolCallId: "t1",
        _meta: { permission: { version: 2, description: "unreadable" } },
      }).reason
    ).toBeNull()
  })

  it("reads claude's defaultToNo hint under the same version gate", () => {
    // claude-agent-acp ≥0.77.0 forwards the CLI's "must not be approvable by
    // a stray keystroke" hint on the request-level block.
    expect(
      parsePermissionToolCall({
        toolCallId: "t1",
        _meta: {
          permission: { version: 1, title: "Run command?", defaultToNo: true },
        },
      }).defaultToNo
    ).toBe(true)
  })

  it("treats anything but a real defaultToNo:true as absent", () => {
    // This flag only ever makes the card SAFER, so an unreadable shape has to
    // fall back to the ordinary presentation — never claim a hint it did not
    // understand, and never let a missing hint read as "dangerous".
    const cases: unknown[] = [
      { toolCallId: "t1" },
      { toolCallId: "t1", _meta: { permission: { version: 1 } } },
      // Truthy but not boolean.
      {
        toolCallId: "t1",
        _meta: { permission: { version: 1, defaultToNo: "true" } },
      },
      // A revision this build cannot read.
      {
        toolCallId: "t1",
        _meta: { permission: { version: 2, defaultToNo: true } },
      },
    ]
    for (const toolCall of cases) {
      expect(parsePermissionToolCall(toolCall).defaultToNo).toBe(false)
    }
  })
})

describe("parsePermissionToolCall — a heading must not restate the command", () => {
  // The exact frame claude-agent-acp 0.79.0 (#1070) sends for a shell
  // approval: `toolCall.title` and `_meta.permission.title` are both the raw
  // command, and the model's label is left in `rawInput.description`.
  const shellApproval = (input: Record<string, unknown>, command: string) => ({
    toolCallId: "toolu_01",
    kind: "execute",
    status: "pending",
    title: command,
    rawInput: input,
    content: [
      {
        type: "content",
        content: { type: "text", text: input.description ?? "" },
      },
    ],
    _meta: {
      permission: { version: 1, title: command, description: "Reason: policy" },
    },
  })

  it("shows a command block for shell that opens with a brace or a bracket", () => {
    // These are ordinary shell, not JSON envelopes, and PowerShell is full of
    // the third one. Discarding them left `command` null, so the card rendered
    // NO command block and the only place the command appeared was the
    // truncated single-line heading — the precise failure claude-agent-acp
    // 0.79.0 (#1070) set out to make impossible from the adapter's side.
    for (const command of [
      "[ -f package.json ] && pnpm test",
      "{ npm test; }",
      "[System.Environment]::OSVersion",
    ]) {
      const parsed = parsePermissionToolCall(
        shellApproval({ command, description: "Check the project" }, command)
      )
      expect(parsed.command).toBe(command)
      expect(parsed.description).toBe("Check the project")
    }
  })

  it("shows a command block for a command that writes a patch", () => {
    // `looksLikeDiffPayload` is there to stop the broad outer walk from reading
    // a stringified patch as a command; under `rawInput.command` a heredoc that
    // writes one is still just a command.
    const command =
      "cat <<'EOF' > fix.patch\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\nEOF"
    const parsed = parsePermissionToolCall(
      shellApproval({ command, description: "Write the patch file" }, command)
    )
    expect(parsed.command).toBe(command)
    expect(parsed.description).toBe("Write the patch file")
  })

  it("still unwraps a genuinely stringified argv envelope", () => {
    // The behaviour the brace/bracket check was added for, unchanged: only a
    // string that fails to parse falls through as shell.
    expect(
      parsePermissionToolCall({
        toolCallId: "t1",
        rawInput: { argv: '["bash","-lc","ls -la"]' },
      }).command
    ).toBe("bash -lc ls -la")
  })

  it("keeps an unreadable outer payload out of the command block", () => {
    // Nothing named this a command, so the conservative reading stands.
    expect(
      parsePermissionToolCall({ toolCallId: "t1", rawInput: "{not json" })
        .command
    ).toBeNull()
    expect(
      parsePermissionToolCall({
        toolCallId: "t1",
        rawInput: { input: "*** Begin Patch\n*** Update File: x.ts\n" },
      }).command
    ).toBeNull()
  })

  it("does not let a command key launder a generic payload into a command", () => {
    // `args` names a command on some agents and is a plain MCP argument bag on
    // others, so the leaf under it only counts when `args` itself IS the
    // string. A false command here would also suppress the card's description
    // block, trading a useful sentence for a tool argument dressed as shell.
    expect(
      parsePermissionToolCall({
        toolCallId: "t1",
        rawInput: { args: { payload: '{"query":"hello"}' } },
      }).command
    ).toBeNull()
    // Directly under the key, but a well-formed envelope carrying no command.
    expect(
      parsePermissionToolCall({
        toolCallId: "t1",
        rawInput: { args: '{"a":1}' },
      }).command
    ).toBeNull()
    // The diff guard likewise stops at the first wrapper hop.
    expect(
      parsePermissionToolCall({
        toolCallId: "t1",
        rawInput: {
          command: { input: "*** Begin Patch\n*** Update File: x\n" },
        },
      }).command
    ).toBeNull()
  })

  it("takes the model's label back when the meta heading IS the command", () => {
    const parsed = parsePermissionToolCall(
      shellApproval(
        { command: "pnpm test", description: "Run the test suite" },
        "pnpm test"
      )
    )
    // Without this the heading and the command block below it both read
    // "pnpm test", and "Run the test suite" never appears on the card at all.
    expect(parsed.description).toBe("Run the test suite")
    expect(parsed.command).toBe("pnpm test")
    expect(parsed.title).toBe("pnpm test")
    expect(parsed.reason).toBe("Reason: policy")
  })

  it("holds for a multi-line command, which is where a squashed heading is worst", () => {
    const command = 'set -e\nfor f in *.ts; do\n  echo "$f"\ndone'
    const parsed = parsePermissionToolCall(
      shellApproval(
        { command, description: "List the TypeScript files" },
        command
      )
    )
    expect(parsed.description).toBe("List the TypeScript files")
    expect(parsed.command).toBe(command)
  })

  it("keeps the command as the heading when the model supplied no label", () => {
    // Nothing better exists, and a heading is still better than none.
    const parsed = parsePermissionToolCall(
      shellApproval({ command: "ls -la" }, "ls -la")
    )
    expect(parsed.description).toBe("ls -la")
  })

  it("does not promote a label that merely repeats the command", () => {
    const parsed = parsePermissionToolCall(
      shellApproval({ command: "ls -la", description: "ls -la" }, "ls -la")
    )
    expect(parsed.description).toBe("ls -la")
  })

  it("bounds an agent-authored label before it becomes a heading", () => {
    const parsed = parsePermissionToolCall(
      shellApproval({ command: "ls", description: "x".repeat(5_000) }, "ls")
    )
    expect(parsed.description).toHaveLength(200)
  })

  it("leaves every heading that says something the command block does not", () => {
    // codex-acp ≥1.7.0: four fixed titles, none of them the command.
    expect(
      parsePermissionToolCall({
        toolCallId: "command-7",
        title: "Run command",
        rawInput: { command: "npm test", description: "ignored here" },
        _meta: { permission: { version: 1, title: "Run command?" } },
      }).description
    ).toBe("Run command?")
    // claude ≤0.78.0, whose `_meta.permission.title` already WAS the label.
    expect(
      parsePermissionToolCall({
        toolCallId: "toolu_01",
        title: "Run the test suite",
        rawInput: { command: "pnpm test", description: "Run the test suite" },
        _meta: { permission: { version: 1, title: "Run the test suite" } },
      }).description
    ).toBe("Run the test suite")
    // A non-command card is untouched: no command, nothing to collide with.
    expect(
      parsePermissionToolCall({
        toolCallId: "toolu_02",
        title: "Write src/a.ts",
        rawInput: { file_path: "src/a.ts", content: "x" },
        _meta: { permission: { version: 1, title: "Write src/a.ts" } },
      }).description
    ).toBe("Write src/a.ts")
  })
})
