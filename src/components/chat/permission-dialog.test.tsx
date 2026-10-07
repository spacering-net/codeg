import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import { PermissionDialog } from "./permission-dialog"
import enMessages from "@/i18n/messages/en.json"
import type { PendingPermission } from "@/contexts/acp-connections-context"

// MessageResponse (Streamdown) pulls in async Shiki highlighting + the
// link-safety hook — too heavy for this unit test, and its Markdown correctness
// is covered elsewhere. Stub it to a sentinel that echoes its source so we can
// assert the agent's content text is routed THROUGH the Markdown renderer
// rather than dumped as raw JSON.
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: string }) => (
    <div data-testid="markdown-response">{children}</div>
  ),
}))

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

const baseOptions = [
  { option_id: "allow", name: "Allow once", kind: "allow_once" },
  { option_id: "reject", name: "Reject", kind: "reject_once" },
]

describe("PermissionDialog", () => {
  // `deepseek-acp` hardcodes its approval buttons in Simplified Chinese and has
  // no locale switch, so the dialog re-labels them from the option ids.
  it("localises an agent's hardcoded approval labels, keeping the ids it answers with", () => {
    const onRespond = vi.fn()
    const permission: PendingPermission = {
      request_id: "req-ds",
      tool_call: { title: "ls", kind: "execute" },
      options: [
        { option_id: "allow-once", name: "允许本次", kind: "allow_once" },
        { option_id: "reject-once", name: "拒绝", kind: "reject_once" },
      ],
    }
    renderWithIntl(
      <PermissionDialog
        permission={permission}
        onRespond={onRespond}
        agentType="deepseek"
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }))
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument()
    expect(screen.queryByText("允许本次")).not.toBeInTheDocument()
    expect(onRespond).toHaveBeenCalledWith("req-ds", "allow-once")
  })

  it("leaves another agent's option labels verbatim", () => {
    const permission: PendingPermission = {
      request_id: "req-cx",
      tool_call: { title: "ls", kind: "execute" },
      options: [
        { option_id: "allow-once", name: "允许本次", kind: "allow_once" },
      ],
    }
    renderWithIntl(
      <PermissionDialog
        permission={permission}
        onRespond={() => {}}
        agentType="codex"
      />
    )
    expect(screen.getByRole("button", { name: "允许本次" })).toBeInTheDocument()
  })

  // `bg-primary` is what the `default` Button variant contributes and the
  // `outline` one does not, so it reads as "this is the emphasised button".
  const isEmphasised = (name: string) =>
    screen.getByRole("button", { name }).className.includes("bg-primary")

  it("emphasises the approval on an ordinary ask", () => {
    const permission: PendingPermission = {
      request_id: "req-plain",
      tool_call: { title: "ls", kind: "execute" },
      options: baseOptions,
    }
    renderWithIntl(
      <PermissionDialog permission={permission} onRespond={() => {}} />
    )
    expect(isEmphasised("Allow once")).toBe(true)
    expect(isEmphasised("Reject")).toBe(false)
  })

  it("emphasises the decline when claude marks the ask defaultToNo", () => {
    // claude-agent-acp ≥0.77.0: "must not be approvable by a stray keystroke".
    // codeg pre-selects nothing and binds no key, so the only thing left to
    // give the decline is the accent colour the approve normally holds.
    const permission: PendingPermission = {
      request_id: "req-danger",
      tool_call: {
        title: "rm -rf build",
        kind: "execute",
        _meta: {
          permission: {
            version: 1,
            title: "Run command?",
            defaultToNo: true,
          },
        },
      },
      options: baseOptions,
    }
    renderWithIntl(
      <PermissionDialog permission={permission} onRespond={() => {}} />
    )
    expect(isEmphasised("Reject")).toBe(true)
    expect(isEmphasised("Allow once")).toBe(false)
  })

  it("returns nothing when permission is null", () => {
    const { container } = renderWithIntl(
      <PermissionDialog permission={null} onRespond={() => {}} />
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders the parsed title and the english subtitle copy", () => {
    const permission: PendingPermission = {
      request_id: "req-1",
      tool_call: { title: "Run unit tests", kind: "shell" },
      options: baseOptions,
    }
    renderWithIntl(
      <PermissionDialog permission={permission} onRespond={() => {}} />
    )
    expect(screen.getByText("Run unit tests")).toBeInTheDocument()
    expect(
      screen.getByText("Agent requests permission to continue this turn.")
    ).toBeInTheDocument()
  })

  it("shows the agent's own reason in place of the boilerplate subtitle", () => {
    // codex-acp ≥1.7.0 keeps the reason ONLY in the request-level
    // `_meta.permission` the backend hoists onto the card; `title` degraded to
    // a fixed string. The subtitle is boilerplate, so the reason replaces it.
    const permission: PendingPermission = {
      request_id: "req-1",
      tool_call: {
        title: "Edit files",
        kind: "edit",
        _meta: {
          permission: {
            version: 1,
            title: "Make edits?",
            description: "The migration renames a column used by two callers.",
          },
        },
      },
      options: baseOptions,
    }
    renderWithIntl(
      <PermissionDialog permission={permission} onRespond={() => {}} />
    )
    expect(
      screen.getByText("The migration renames a column used by two callers.")
    ).toBeInTheDocument()
    expect(
      screen.queryByText("Agent requests permission to continue this turn.")
    ).not.toBeInTheDocument()
    // The permission title beats the generic tool-call one as the heading.
    expect(screen.getByText("Make edits?")).toBeInTheDocument()
  })

  it("shows how many approvals are queued behind this card, and hides the badge at zero", () => {
    // Approvals are surfaced one at a time (backend FIFO, #442). Without this
    // count the remaining ones read as the agent having stopped responding.
    const permission: PendingPermission = {
      request_id: "req-1",
      tool_call: { title: "Run unit tests", kind: "shell" },
      options: baseOptions,
      queued: 3,
    }
    const { unmount } = renderWithIntl(
      <PermissionDialog permission={permission} onRespond={() => {}} />
    )
    expect(screen.getByText("+3 waiting")).toBeInTheDocument()
    unmount()

    // A lone approval must not be decorated with a "+0 waiting" badge; neither
    // must an older event/snapshot that carries no count at all.
    for (const queued of [0, undefined]) {
      const { unmount: cleanup } = renderWithIntl(
        <PermissionDialog
          permission={{ ...permission, queued }}
          onRespond={() => {}}
        />
      )
      expect(screen.queryByText(/waiting/)).not.toBeInTheDocument()
      cleanup()
    }
  })

  it("prefers the _meta.claudeCode.title description over the command title (≥0.63)", () => {
    // claude-agent-acp ≥0.63 eager permission tool_call: ACP `title` is the
    // shell command, `_meta.claudeCode.title` the human description. The
    // header shows the description; the command still renders in its block.
    const permission: PendingPermission = {
      request_id: "req-desc",
      tool_call: {
        title: "git diff",
        kind: "execute",
        rawInput: { command: "git diff", description: "Show current diff" },
        _meta: { claudeCode: { toolName: "Bash", title: "Show current diff" } },
      },
      options: baseOptions,
    }
    renderWithIntl(
      <PermissionDialog permission={permission} onRespond={() => {}} />
    )
    expect(screen.getByText("Show current diff")).toBeInTheDocument()
    // The command surfaces in the CodeBlock, not as the header.
    expect(screen.queryByText("git diff")).toBeInTheDocument()
  })

  it("renders every option as a button", () => {
    const permission: PendingPermission = {
      request_id: "req-2",
      tool_call: null,
      options: baseOptions,
    }
    renderWithIntl(
      <PermissionDialog permission={permission} onRespond={() => {}} />
    )
    expect(
      screen.getByRole("button", { name: "Allow once" })
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument()
  })

  it("invokes onRespond with the request_id + chosen option_id when clicked", () => {
    const onRespond = vi.fn()
    const permission: PendingPermission = {
      request_id: "req-abc",
      tool_call: null,
      options: baseOptions,
    }
    renderWithIntl(
      <PermissionDialog permission={permission} onRespond={onRespond} />
    )
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }))
    expect(onRespond).toHaveBeenCalledWith("req-abc", "allow")
  })

  it("falls back to a JSON preview when the tool_call has no structured fields", () => {
    // Tool calls with no command / file changes / plan / web / etc. should
    // hit the `jsonPreview` branch so the user still sees raw input.
    const permission: PendingPermission = {
      request_id: "req-3",
      tool_call: { kind: "unknown_tool", payload: { hello: "world" } },
      options: baseOptions,
    }
    const { container } = renderWithIntl(
      <PermissionDialog permission={permission} onRespond={() => {}} />
    )
    const pre = container.querySelector("pre")
    expect(pre).not.toBeNull()
    expect(pre?.textContent).toContain("hello")
    expect(pre?.textContent).toContain("world")
  })

  it("renders the agent description from ACP content text instead of raw JSON", () => {
    // Kimi Code carries the request description in the ACP `content` array
    // (`{ type: "content", content: { type: "text", text } }`) and populates
    // nothing in rawInput. The dialog should surface that text via the Markdown
    // renderer rather than dumping the whole tool_call as raw JSON.
    const permission: PendingPermission = {
      request_id: "req-kimi",
      tool_call: {
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Requesting approval to Running: mkdir -p app/todo-test",
            },
          },
        ],
        title: "Bash",
        toolCallId: "0:Bash_8",
        kind: "execute",
      },
      options: baseOptions,
    }
    const { container } = renderWithIntl(
      <PermissionDialog permission={permission} onRespond={() => {}} />
    )
    const markdown = screen.getByTestId("markdown-response")
    expect(markdown).toHaveTextContent(
      "Requesting approval to Running: mkdir -p app/todo-test"
    )
    expect(container.querySelector("pre")).toBeNull()
  })

  it("lists what each option grants from _meta.permission.changes (codex ≥1.1.8)", () => {
    // codex-acp #342 hangs a structured, already-humanized change list on each
    // permission option. The card must show those sentences so "Allow for
    // Session" stops being an opaque button. codex states the duration inside
    // its own sentences AND in `lifetime`, so the suffix repeats it here —
    // uniform rendering beats string-sniffing whether it is already spelled out.
    const permission: PendingPermission = {
      request_id: "req-changes",
      tool_call: { title: "Need extra access", kind: "other" },
      options: [
        {
          option_id: "allow_permissions_session",
          name: "Allow for Session",
          kind: "allow_always",
          meta: {
            permission: {
              version: 1,
              changes: [
                {
                  type: "grant",
                  operation: "grant",
                  description: "Allow network access for this session",
                  lifetime: { scope: "session" },
                },
                {
                  type: "grant",
                  operation: "grant",
                  description:
                    "Allow write access to /repo/tmp for this session",
                  lifetime: { scope: "session" },
                },
              ],
            },
          },
        },
        { option_id: "reject", name: "Reject", kind: "reject_once" },
      ],
    }
    renderWithIntl(
      <PermissionDialog permission={permission} onRespond={() => {}} />
    )
    expect(
      screen.getByText(/Allow network access for this session/)
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Allow write access to \/repo\/tmp for this session/)
    ).toBeInTheDocument()
    // The grant list names its option, and the button itself keeps its label.
    expect(screen.getAllByText("Allow for Session")).toHaveLength(2)
    expect(screen.getAllByText("This session")).toHaveLength(2)
  })

  it("spells out how long each change lasts (claude ≥0.64.1)", () => {
    // claude-agent-acp #930 speaks the same contract, but its descriptions
    // NEVER state the duration — that lives only in `lifetime`. Unread, this
    // card would pair "Always Allow" with "Allow all Bash calls" and never
    // reveal that the rule is about to be written into settings the repo
    // commits. Only the always-allow option carries metadata, as claude sends it.
    const permission: PendingPermission = {
      request_id: "req-claude-changes",
      tool_call: { title: "Bash", kind: "execute" },
      options: [
        { option_id: "reject", name: "Deny", kind: "reject_once" },
        { option_id: "allow", name: "Allow Once", kind: "allow_once" },
        {
          option_id: "allow_always",
          name: "Always Allow",
          kind: "allow_always",
          meta: {
            permission: {
              version: 1,
              changes: [
                {
                  type: "policy_rule",
                  operation: "add",
                  ruleBehavior: "allow",
                  description: "Allow Bash calls matching npm test:*",
                  lifetime: { scope: "persistent", storage: "project" },
                  targets: [{ type: "tool", toolName: "Bash" }],
                },
                {
                  type: "permission_mode",
                  operation: "set",
                  description: "Set Claude Code permission mode to acceptEdits",
                  lifetime: { scope: "unknown" },
                },
              ],
            },
          },
        },
      ],
    }
    renderWithIntl(
      <PermissionDialog permission={permission} onRespond={() => {}} />
    )
    expect(
      screen.getByText(/Allow Bash calls matching npm test:\*/)
    ).toBeInTheDocument()
    expect(screen.getByText("Saved to project settings")).toBeInTheDocument()
    // An unknown scope says nothing about duration rather than guessing.
    expect(
      screen.getByText(/Set Claude Code permission mode to acceptEdits/)
    ).toBeInTheDocument()
    expect(screen.queryByText("Saved permanently")).toBeNull()
    // Options without metadata are named by their button alone — the grant
    // list only lists the one option that carries metadata.
    expect(screen.getByText("Allow Once")).toBeInTheDocument()
    expect(screen.getAllByText("Always Allow")).toHaveLength(2)
    expect(screen.getByText("What each option grants")).toBeInTheDocument()
  })

  it("ignores option metadata that is absent or of an unknown version", () => {
    const permission: PendingPermission = {
      request_id: "req-nochanges",
      tool_call: { title: "Run unit tests", kind: "shell" },
      options: [
        {
          option_id: "allow",
          name: "Allow once",
          kind: "allow_once",
          // A future revision codeg does not understand must render nothing
          // rather than a half-read list.
          meta: {
            permission: {
              version: 2,
              changes: [{ description: "Something new" }],
            },
          },
        },
        { option_id: "reject", name: "Reject", kind: "reject_once" },
      ],
    }
    renderWithIntl(
      <PermissionDialog permission={permission} onRespond={() => {}} />
    )
    expect(screen.queryByText(/Something new/)).toBeNull()
    expect(screen.getByText("Allow once")).toBeInTheDocument()
  })
})
